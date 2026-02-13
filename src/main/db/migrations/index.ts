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

export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  // Add future migrations here in order
]
