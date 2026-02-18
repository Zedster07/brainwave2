/**
 * Migration Registry
 * Import all migrations here and export as ordered array
 */
import { Migration } from '../migrations'
import migration001 from './001_initial_schema'
import migration002 from './002_chat_sessions'
import migration003 from './003_confidence_calibration'
import migration004 from './004_prompt_versioning'
import migration005 from './005_people_attributes'
import migration006 from './006_session_type'
import migration007 from './007_task_checkpoints'
import migration008 from './008_embedding_cache'

export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  // Add future migrations here in order
]
