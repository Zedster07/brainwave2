/**
 * Confidence Calibration Tracker
 *
 * Tracks agent confidence vs. user feedback to build calibration metrics.
 * Provides per-agent accuracy stats and adaptive threshold recommendations.
 *
 * Key concepts:
 * - "Calibrated" = agent's stated confidence aligns with actual success rate
 * - Over-confident = confidence > actual success rate (dangerous — user trusts bad results)
 * - Under-confident = confidence < actual success rate (annoying — unnecessary escalations)
 */
import { getDatabase } from '../db/database'
import type { AgentType } from './event-bus'

// ─── Types ──────────────────────────────────────────────────

export interface CalibrationStats {
  agentType: string
  totalRuns: number
  runsWithFeedback: number
  positiveRate: number         // % of feedback that was positive
  avgConfidence: number        // mean confidence across all runs
  avgConfidencePositive: number // mean confidence on positive-feedback runs
  avgConfidenceNegative: number // mean confidence on negative-feedback runs
  calibrationError: number     // |avgConfidence - positiveRate| — lower is better
  overConfident: boolean       // agent claims high confidence but low positive rate
}

export interface CalibrationBucket {
  range: string              // e.g., "0.6-0.7"
  rangeMin: number
  rangeMax: number
  count: number
  positiveCount: number
  negativeCount: number
  actualPositiveRate: number  // true positive rate within this bucket
}

export interface CalibrationReport {
  generatedAt: number
  agents: CalibrationStats[]
  buckets: CalibrationBucket[]
  recommendedThresholds: {
    escalateBelow: number    // confidence threshold for ask_user
    trustAbove: number       // confidence threshold for auto-approve
  }
}

// ─── Calibration Tracker ────────────────────────────────────

export class CalibrationTracker {
  private db = getDatabase()

  /**
   * Record user feedback for a specific agent run.
   */
  submitFeedback(runId: string, feedback: 'positive' | 'negative'): void {
    this.db.run(
      `UPDATE agent_runs SET user_feedback = ? WHERE id = ?`,
      feedback, runId
    )
  }

  /**
   * Get per-agent calibration statistics.
   */
  getAgentStats(agentType?: string): CalibrationStats[] {
    const where = agentType ? `WHERE agent_type = ?` : `WHERE status = 'completed'`
    const params = agentType ? [agentType] : []

    const rows = this.db.all<{
      agent_type: string
      total: number
      with_feedback: number
      positive: number
      negative: number
      avg_confidence: number
      avg_conf_pos: number | null
      avg_conf_neg: number | null
    }>(
      `SELECT
        agent_type,
        COUNT(*) as total,
        COUNT(user_feedback) as with_feedback,
        SUM(CASE WHEN user_feedback = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN user_feedback = 'negative' THEN 1 ELSE 0 END) as negative,
        AVG(confidence) as avg_confidence,
        AVG(CASE WHEN user_feedback = 'positive' THEN confidence END) as avg_conf_pos,
        AVG(CASE WHEN user_feedback = 'negative' THEN confidence END) as avg_conf_neg
      FROM agent_runs
      ${where} AND confidence IS NOT NULL
      GROUP BY agent_type
      ORDER BY total DESC`,
      ...params
    )

    return rows.map((row) => {
      const positiveRate = row.with_feedback > 0
        ? row.positive / row.with_feedback
        : 0
      const avgConf = row.avg_confidence ?? 0

      return {
        agentType: row.agent_type,
        totalRuns: row.total,
        runsWithFeedback: row.with_feedback,
        positiveRate,
        avgConfidence: avgConf,
        avgConfidencePositive: row.avg_conf_pos ?? 0,
        avgConfidenceNegative: row.avg_conf_neg ?? 0,
        calibrationError: Math.abs(avgConf - positiveRate),
        overConfident: avgConf > positiveRate + 0.15 && row.with_feedback >= 5,
      }
    })
  }

  /**
   * Get confidence calibration buckets (reliability diagram data).
   * Groups runs by confidence range and shows actual positive rate per bucket.
   */
  getCalibrationBuckets(bucketCount = 5): CalibrationBucket[] {
    const step = 1.0 / bucketCount
    const buckets: CalibrationBucket[] = []

    for (let i = 0; i < bucketCount; i++) {
      const rangeMin = i * step
      const rangeMax = (i + 1) * step

      const row = this.db.get<{
        count: number
        positive: number
        negative: number
      }>(
        `SELECT
          COUNT(*) as count,
          SUM(CASE WHEN user_feedback = 'positive' THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN user_feedback = 'negative' THEN 1 ELSE 0 END) as negative
        FROM agent_runs
        WHERE confidence >= ? AND confidence < ?
          AND user_feedback IS NOT NULL
          AND status = 'completed'`,
        rangeMin, i === bucketCount - 1 ? rangeMax + 0.01 : rangeMax
      )

      const count = row?.count ?? 0
      const positive = row?.positive ?? 0
      const negative = row?.negative ?? 0

      buckets.push({
        range: `${rangeMin.toFixed(1)}-${rangeMax.toFixed(1)}`,
        rangeMin,
        rangeMax,
        count,
        positiveCount: positive,
        negativeCount: negative,
        actualPositiveRate: count > 0 ? positive / count : 0,
      })
    }

    return buckets
  }

  /**
   * Generate a full calibration report with recommended thresholds.
   */
  getReport(): CalibrationReport {
    const agents = this.getAgentStats()
    const buckets = this.getCalibrationBuckets()

    // Recommend thresholds based on calibration data
    const thresholds = this.computeRecommendedThresholds(buckets)

    return {
      generatedAt: Date.now(),
      agents,
      buckets,
      recommendedThresholds: thresholds,
    }
  }

  /**
   * Get the recommended confidence threshold for a specific agent type.
   * If we have enough feedback data, use per-agent calibration.
   * Otherwise, fall back to global defaults.
   */
  getEscalationThreshold(agentType: AgentType): number {
    const stats = this.getAgentStats(agentType)
    const agentStat = stats.find((s) => s.agentType === agentType)

    // Need at least 10 runs with feedback for per-agent calibration
    if (agentStat && agentStat.runsWithFeedback >= 10) {
      // If agent is over-confident, raise the threshold (more escalation)
      if (agentStat.overConfident) {
        return Math.min(0.7, agentStat.avgConfidenceNegative + 0.1)
      }
      // Otherwise, use the midpoint between positive and negative avg confidence
      if (agentStat.avgConfidenceNegative > 0) {
        return (agentStat.avgConfidencePositive + agentStat.avgConfidenceNegative) / 2
      }
    }

    // Default threshold
    return 0.4
  }

  /**
   * Get recent runs that haven't been rated yet, for feedback prompting.
   */
  getUnratedRuns(limit = 10): Array<{
    id: string
    agentType: string
    confidence: number
    output: string
    completedAt: string
  }> {
    return this.db.all<{
      id: string
      agent_type: string
      confidence: number
      output: string
      completed_at: string
    }>(
      `SELECT id, agent_type, confidence, output, completed_at
       FROM agent_runs
       WHERE user_feedback IS NULL
         AND status = 'completed'
         AND confidence IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT ?`,
      limit
    ).map((row) => ({
      id: row.id,
      agentType: row.agent_type,
      confidence: row.confidence,
      output: row.output ?? '',
      completedAt: row.completed_at,
    }))
  }

  // ─── Private Helpers ────────────────────────────────────

  /**
   * Compute recommended escalation thresholds from calibration buckets.
   * - escalateBelow: the confidence level below which positive rate drops significantly
   * - trustAbove: the confidence level above which positive rate is consistently high
   */
  private computeRecommendedThresholds(buckets: CalibrationBucket[]): {
    escalateBelow: number
    trustAbove: number
  } {
    const bucketsWithData = buckets.filter((b) => b.count >= 3)

    if (bucketsWithData.length < 2) {
      // Not enough data — use conservative defaults
      return { escalateBelow: 0.4, trustAbove: 0.8 }
    }

    // Escalation threshold: find the highest bucket where positive rate < 60%
    let escalateBelow = 0.4
    for (const bucket of bucketsWithData) {
      if (bucket.actualPositiveRate < 0.6) {
        escalateBelow = Math.max(escalateBelow, bucket.rangeMax)
      }
    }

    // Trust threshold: find the lowest bucket where positive rate >= 85%
    let trustAbove = 0.8
    for (const bucket of bucketsWithData) {
      if (bucket.actualPositiveRate >= 0.85 && bucket.rangeMin < trustAbove) {
        trustAbove = bucket.rangeMin
      }
    }

    // Ensure escalate < trust
    if (escalateBelow >= trustAbove) {
      trustAbove = Math.min(1.0, escalateBelow + 0.2)
    }

    return { escalateBelow, trustAbove }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: CalibrationTracker | null = null

export function getCalibrationTracker(): CalibrationTracker {
  if (!instance) {
    instance = new CalibrationTracker()
  }
  return instance
}
