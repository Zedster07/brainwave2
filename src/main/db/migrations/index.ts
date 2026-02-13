/**
 * Migration Registry
 * Import all migrations here and export as ordered array
 */
import { Migration } from '../migrations'
import migration001 from './001_initial_schema'

export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  // Add future migrations here in order
]
