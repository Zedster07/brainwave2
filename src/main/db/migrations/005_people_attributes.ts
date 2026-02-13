import { Migration } from '../migrations'

/**
 * Migration 005 — People Attributes
 * Adds first-class columns for personal details (email, phone, address,
 * birthday, age, gender, occupation, company, social links, notes, nickname, full name).
 * These were previously crammed into the preferences JSON blob.
 */
const migration: Migration = {
  version: 5,
  name: 'people_attributes',
  up: `
    ALTER TABLE people ADD COLUMN nickname TEXT;
    ALTER TABLE people ADD COLUMN full_name TEXT;
    ALTER TABLE people ADD COLUMN email TEXT;
    ALTER TABLE people ADD COLUMN phone TEXT;
    ALTER TABLE people ADD COLUMN address TEXT;
    ALTER TABLE people ADD COLUMN birthday TEXT;
    ALTER TABLE people ADD COLUMN age INTEGER;
    ALTER TABLE people ADD COLUMN gender TEXT;
    ALTER TABLE people ADD COLUMN occupation TEXT;
    ALTER TABLE people ADD COLUMN company TEXT;
    ALTER TABLE people ADD COLUMN social_links TEXT DEFAULT '{}';
    ALTER TABLE people ADD COLUMN notes TEXT;
  `,
  down: `
    -- SQLite does not support DROP COLUMN before 3.35.0
    -- These columns will simply be ignored if not present
  `,
}

export default migration
