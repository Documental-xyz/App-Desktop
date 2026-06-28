/**
 * @fileoverview Database initialization and management module
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const { getLogger } = require('../logging/logger.js');
const { PlatformService } = require('../services/platform/PlatformService');

/**
 * @typedef {Object} DatabaseConfig
 * @property {string} userDataPath - Path to user data directory
 * @property {string} dbName - Database filename
 */

/**
 * Database manager class for SQLite operations
 */
class DatabaseManager {
  /**
   * Create a new DatabaseManager instance
   * @param {DatabaseConfig} config - Database configuration
   */
  constructor(config = {}) {
    this.logger = getLogger('Database');
    this.db = null;
    this.platformService = new PlatformService({ logger: this.logger });
    this.config = {
      userDataPath: config.userDataPath,
      dbName: config.dbName || 'documental.db'
    };
  }

  /**
   * Initialize database connection and create tables
   * @returns {Promise<void>}
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      const dbPath = this.platformService.joinPath(this.config.userDataPath, this.config.dbName);
      
      this.logger.info(`🗄️ Initializing database at: ${dbPath}`);
      
      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          this.logger.error('❌ Error opening database:', err.message);
          reject(err);
        } else {
          this.logger.info('✅ Connected to SQLite database');
          this.createTables()
            .then(() => resolve())
            .catch(reject);
        }
      });
    });
  }

  /**
   * Create necessary database tables
   * @returns {Promise<void>}
   */
  async createTables() {
    return new Promise((resolve, reject) => {
      const createProjectsTable = `
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          projectName TEXT NOT NULL,
          projectPath TEXT NOT NULL,
          repoFolderName TEXT,
          repoUrl TEXT,
          repoFullName TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `;

      const createUsersTable = `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          githubId TEXT UNIQUE,
          login TEXT,
          name TEXT,
          email TEXT,
          avatarUrl TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `;

      const createSettingsTable = `
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT UNIQUE NOT NULL,
          value TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `;

      this.db.run(createProjectsTable, (err) => {
        if (err) {
          this.logger.error('❌ Error creating projects table:', err.message);
          reject(err);
          return;
        }

        // Safe migration: add repoFullName column if it doesn't exist (for existing DBs)
        this.db.run(`ALTER TABLE projects ADD COLUMN repoFullName TEXT`, (alterErr) => {
          if (alterErr && !alterErr.message.includes('duplicate column')) {
            this.logger?.error?.('Migration error (repoFullName):', alterErr.message);
          }
        });
        
        this.db.run(createUsersTable, (err) => {
          if (err) {
            this.logger.error('❌ Error creating users table:', err.message);
            reject(err);
            return;
          }
          
          this.db.run(createSettingsTable, (err) => {
            if (err) {
              this.logger.error('❌ Error creating settings table:', err.message);
              reject(err);
            } else {
              this.logger.info('✅ Database tables created successfully');
              resolve();
            }
          });
        });
      });
    });
  }

  /**
   * Get database instance
   * @returns {sqlite3.Database} Database instance
   */
  getDatabase() {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Close database connection
   * @returns {Promise<void>}
   */
  async close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            this.logger.error('❌ Error closing database:', err.message);
            reject(err);
          } else {
            this.logger.info('✅ Database connection closed');
            this.db = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Execute a query with parameters
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>} Query result
   */
  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ 
            id: this.lastID, 
            changes: this.changes 
          });
        }
      });
    });
  }

  /**
   * Execute a query that returns rows
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>} Query rows
   */
  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  /**
   * Execute a query that returns a single row
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object|null>} Query row or null
   */
  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }
}

module.exports = {
  DatabaseManager
};