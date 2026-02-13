import { useState, useEffect, useCallback, useRef } from 'react'
import * as d3 from 'd3'
import {
  GitBranch,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Users,
  Database,
  Brain,
  Info,
} from 'lucide-react'
import type { PersonEntry, MemoryEntry } from '@shared/types'

// ─── Graph Types ────────────────────────────────────────────

interface GraphNode extends d3.SimulationNodeDatum {
  id: string
  label: string
  type: 'person' | 'concept' | 'memory'
  color: string
  radius: number
  metadata?: Record<string, unknown>
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  type: 'knows' | 'related' | 'mentioned'
  strength: number
}

const NODE_COLORS: Record<GraphNode['type'], string> = {
  person: '#f43f5e',   // rose-500
  concept: '#6366f1',  // indigo-500 (accent)
  memory: '#3b82f6',   // blue-500
}

// ─── Main Component ─────────────────────────────────────────

export function KnowledgeGraph() {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [links, setLinks] = useState<GraphLink[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [stats, setStats] = useState({ people: 0, concepts: 0, memories: 0, connections: 0 })

  // ─── Data Loading ───────────────────────────────────────

  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      const [people, semanticMemories] = await Promise.all([
        window.brainwave.getAllPeople(),
        window.brainwave.queryMemory({ query: '*', type: 'semantic', limit: 100 }),
      ])

      const { graphNodes, graphLinks } = buildGraph(people, semanticMemories)
      setNodes(graphNodes)
      setLinks(graphLinks)
      setStats({
        people: people.length,
        concepts: graphNodes.filter((n) => n.type === 'concept').length,
        memories: semanticMemories.length,
        connections: graphLinks.length,
      })
    } catch (err) {
      console.error('Failed to load knowledge graph:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGraph()
  }, [loadGraph])

  // ─── D3 Simulation ─────────────────────────────────────

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || nodes.length === 0) return

    const svg = d3.select(svgRef.current)
    const container = containerRef.current
    const width = container.clientWidth
    const height = container.clientHeight

    svg.selectAll('*').remove()
    svg.attr('width', width).attr('height', height)

    // Zoom behavior
    const zoomGroup = svg.append('g')
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .on('zoom', (event) => zoomGroup.attr('transform', event.transform))
    svg.call(zoom)

    // Arrow markers for links
    svg.append('defs').append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '-0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M 0,-5 L 10,0 L 0,5')
      .attr('fill', 'rgba(255,255,255,0.15)')

    // Create simulation
    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links)
        .id((d) => d.id)
        .distance(100)
        .strength((d) => d.strength * 0.3))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: GraphNode) => d.radius + 8))

    simulationRef.current = simulation

    // Draw links
    const link = zoomGroup.append('g')
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(links)
      .join('line')
      .attr('stroke', 'rgba(255,255,255,0.08)')
      .attr('stroke-width', (d) => Math.max(1, d.strength * 3))
      .attr('marker-end', 'url(#arrowhead)')

    // Draw nodes
    const node = zoomGroup.append('g')
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag<SVGGElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
        })
      )

    // Node circles
    node.append('circle')
      .attr('r', (d) => d.radius)
      .attr('fill', (d) => d.color)
      .attr('fill-opacity', 0.2)
      .attr('stroke', (d) => d.color)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.6)

    // Node labels
    node.append('text')
      .text((d) => d.label.length > 16 ? d.label.slice(0, 14) + '…' : d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => d.radius + 14)
      .attr('fill', 'rgba(255,255,255,0.5)')
      .attr('font-size', '10px')
      .attr('font-family', 'system-ui, sans-serif')

    // Hover effects
    node.on('mouseenter', function(_event, d) {
      d3.select(this).select('circle')
        .transition().duration(150)
        .attr('fill-opacity', 0.4)
        .attr('stroke-opacity', 1)
        .attr('r', d.radius + 3)
    })
    .on('mouseleave', function(_event, d) {
      d3.select(this).select('circle')
        .transition().duration(150)
        .attr('fill-opacity', 0.2)
        .attr('stroke-opacity', 0.6)
        .attr('r', d.radius)
    })
    .on('click', (_event, d) => {
      setSelectedNode(d)
    })

    // Simulation tick
    simulation.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as GraphNode).x!)
        .attr('y1', (d) => (d.source as GraphNode).y!)
        .attr('x2', (d) => (d.target as GraphNode).x!)
        .attr('y2', (d) => (d.target as GraphNode).y!)

      node.attr('transform', (d) => `translate(${d.x},${d.y})`)
    })

    // Center on initial load
    svg.call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(1))

    return () => {
      simulation.stop()
    }
  }, [nodes, links])

  // ─── Zoom Controls ─────────────────────────────────────

  const handleZoom = useCallback((factor: number) => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    const zoom = d3.zoom<SVGSVGElement, unknown>()
    svg.transition().duration(300).call(zoom.scaleBy as never, factor)
  }, [])

  const handleFitView = useCallback(() => {
    if (!svgRef.current || !containerRef.current) return
    const svg = d3.select(svgRef.current)
    const zoom = d3.zoom<SVGSVGElement, unknown>()
    const width = containerRef.current.clientWidth
    const height = containerRef.current.clientHeight
    svg.transition().duration(500).call(
      zoom.transform as never,
      d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8).translate(-width / 2, -height / 2)
    )
  }, [])

  // ─── Render ────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <GitBranch className="w-5 h-5 text-accent" />
          <h2 className="text-lg font-semibold text-white">Knowledge Graph</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => handleZoom(1.3)} className="p-1.5 text-gray-500 hover:text-white glass-card-hover" title="Zoom in">
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={() => handleZoom(0.7)} className="p-1.5 text-gray-500 hover:text-white glass-card-hover" title="Zoom out">
            <ZoomOut className="w-4 h-4" />
          </button>
          <button onClick={handleFitView} className="p-1.5 text-gray-500 hover:text-white glass-card-hover" title="Fit view">
            <Maximize2 className="w-4 h-4" />
          </button>
          <button onClick={loadGraph} className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400 hover:text-white glass-card-hover">
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-4">
        <StatBadge icon={Users} label="People" count={stats.people} color="text-rose-400" />
        <StatBadge icon={Database} label="Concepts" count={stats.concepts} color="text-accent" />
        <StatBadge icon={Brain} label="Memories" count={stats.memories} color="text-blue-400" />
        <StatBadge icon={GitBranch} label="Connections" count={stats.connections} color="text-emerald-400" />
      </div>

      {/* Graph canvas */}
      <div ref={containerRef} className="flex-1 glass-card relative overflow-hidden rounded-xl min-h-[300px]">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <RefreshCw className="w-6 h-6 text-gray-600 animate-spin" />
          </div>
        ) : nodes.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <GitBranch className="w-10 h-10 text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-1">Knowledge graph is empty</p>
            <p className="text-xs text-gray-600">Nodes appear as Brainwave learns about people and concepts.</p>
          </div>
        ) : (
          <svg ref={svgRef} className="w-full h-full" />
        )}

        {/* Selected node details */}
        {selectedNode && (
          <div className="absolute bottom-4 left-4 right-4 max-w-sm glass-card p-4 border border-white/[0.08] animate-fade-in">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: selectedNode.color }}
                />
                <h3 className="text-sm font-medium text-white">{selectedNode.label}</h3>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-gray-500 hover:text-white text-xs"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-gray-500">
              <span className="capitalize px-1.5 py-0.5 rounded bg-white/5">{selectedNode.type}</span>
              <span>ID: {selectedNode.id.slice(0, 8)}…</span>
            </div>
            {selectedNode.metadata && Object.keys(selectedNode.metadata).length > 0 && (
              <div className="mt-2 space-y-0.5">
                {Object.entries(selectedNode.metadata).map(([key, val]) => (
                  <p key={key} className="text-[10px] text-gray-500">
                    <span className="text-gray-400">{key}:</span> {String(val)}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 mt-3">
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          <Info className="w-3 h-3" />
          <span>Drag nodes to rearrange • Scroll to zoom • Click for details</span>
        </div>
        <div className="flex items-center gap-3 ml-auto">
          {Object.entries(NODE_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color, opacity: 0.7 }} />
              <span className="text-[10px] text-gray-500 capitalize">{type}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Graph Builder ──────────────────────────────────────────

function buildGraph(
  people: PersonEntry[],
  semanticMemories: MemoryEntry[]
): { graphNodes: GraphNode[]; graphLinks: GraphLink[] } {
  const graphNodes: GraphNode[] = []
  const graphLinks: GraphLink[] = []
  const conceptMap = new Map<string, GraphNode>()

  // Add people nodes
  for (const person of people) {
    graphNodes.push({
      id: person.id,
      label: person.name,
      type: 'person',
      color: NODE_COLORS.person,
      radius: 14,
      metadata: {
        relationship: person.relationship || 'unknown',
        traits: person.traits.join(', ') || 'none',
        interactions: person.interactionHistory.length,
      },
    })

    // Extract concepts from traits
    for (const trait of person.traits) {
      const tid = `concept:${trait.toLowerCase()}`
      if (!conceptMap.has(tid)) {
        const conceptNode: GraphNode = {
          id: tid,
          label: trait,
          type: 'concept',
          color: NODE_COLORS.concept,
          radius: 10,
        }
        conceptMap.set(tid, conceptNode)
        graphNodes.push(conceptNode)
      }
      graphLinks.push({
        source: person.id,
        target: tid,
        type: 'related',
        strength: 0.5,
      })
    }
  }

  // Add semantic memory nodes (as concepts)
  for (const mem of semanticMemories) {
    const tags = (mem.tags || []) as string[]
    // Create a node for the memory itself
    graphNodes.push({
      id: mem.id,
      label: mem.content.slice(0, 30),
      type: 'memory',
      color: NODE_COLORS.memory,
      radius: 8 + mem.importance * 6,
      metadata: {
        importance: `${Math.round(mem.importance * 100)}%`,
        accesses: mem.accessCount,
      },
    })

    // Link memory to concepts derived from tags
    for (const tag of tags) {
      const tid = `concept:${tag.toLowerCase()}`
      if (!conceptMap.has(tid)) {
        const conceptNode: GraphNode = {
          id: tid,
          label: tag,
          type: 'concept',
          color: NODE_COLORS.concept,
          radius: 10,
        }
        conceptMap.set(tid, conceptNode)
        graphNodes.push(conceptNode)
      }
      graphLinks.push({
        source: mem.id,
        target: tid,
        type: 'mentioned',
        strength: 0.3,
      })
    }
  }

  // Link people to people via shared concepts
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const sharedTraits = people[i].traits.filter((t) =>
        people[j].traits.some((t2) => t2.toLowerCase() === t.toLowerCase())
      )
      if (sharedTraits.length > 0) {
        graphLinks.push({
          source: people[i].id,
          target: people[j].id,
          type: 'knows',
          strength: Math.min(1, sharedTraits.length * 0.3),
        })
      }
    }
  }

  return { graphNodes, graphLinks }
}

// ─── Sub-components ─────────────────────────────────────────

function StatBadge({
  icon: Icon,
  label,
  count,
  color,
}: {
  icon: typeof Users
  label: string
  count: number
  color: string
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className="text-gray-500">{label}</span>
      <span className="text-white font-medium">{count}</span>
    </div>
  )
}
