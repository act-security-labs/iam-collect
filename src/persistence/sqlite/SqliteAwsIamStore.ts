import { splitArnParts } from '@actsecurity/iam-utils'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { createHash } from 'crypto'
import {
  type AwsIamStore,
  type OrganizationPolicyType,
  type ResourceTypeParts,
  type StorageClientOptions
} from '../AwsIamStore.js'
import { createStorageStringifier, type StorageStringifier } from '../serialization.js'

function quote(value: any): string {
  if (value === undefined || value === null || value === '') {
    return 'NULL'
  }
  return `'${String(value).replace(/'/g, "''")}'`
}

const CURRENT_SCHEMA_VERSION = '2025-10-14'

/**
 * A SQLite-based implementation of the AwsIamStore interface.
 */
export class SqliteAwsIamStore implements AwsIamStore {
  private readonly db: Database
  private readonly stringifyJson: StorageStringifier

  constructor(
    private readonly dbPath: string,
    private readonly partition: string,
    private readonly iamCollectVersion: string,
    options: StorageClientOptions = {}
  ) {
    this.stringifyJson = createStorageStringifier(options)
    this.db = new DatabaseConstructor(this.dbPath)
    this.init()
  }

  close() {
    this.db.close()
  }

  async writeBatch(fn: () => Promise<void>): Promise<void> {
    this.run('BEGIN')
    try {
      await fn()
      this.run('COMMIT')
    } catch (error) {
      this.run('ROLLBACK')
      throw error
    }
  }

  /**
   * Returns the SQL DDL for a SQLite database.
   *
   * @returns The DDL to create the schema in a SQLite database.
   */
  public static schemaSql(iamCollectVersion: string) {
    return `
    CREATE TABLE IF NOT EXISTS resource_metadata (
      partition TEXT NOT NULL,
      account_id TEXT NOT NULL,
      arn TEXT NOT NULL,
      metadata_type TEXT NOT NULL,
      data TEXT NOT NULL,
      service TEXT NOT NULL,
      region TEXT,
      resource_type TEXT,
      arn_account TEXT,
      PRIMARY KEY (partition, account_id, arn, metadata_type)
    );
    CREATE TABLE IF NOT EXISTS account_metadata (
      partition TEXT NOT NULL,
      account_id TEXT NOT NULL,
      metadata_type TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (partition, account_id, metadata_type)
    );
    CREATE TABLE IF NOT EXISTS organization_metadata (
      partition TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      metadata_type TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (partition, organization_id, metadata_type)
    );
    CREATE TABLE IF NOT EXISTS organizational_unit_metadata (
      partition TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      ou_id TEXT NOT NULL,
      metadata_type TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (partition, organization_id, ou_id, metadata_type)
    );
    CREATE TABLE IF NOT EXISTS organization_policy_metadata (
      partition TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      policy_type TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      metadata_type TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (partition, organization_id, policy_type, policy_id, metadata_type)
    );
    CREATE TABLE IF NOT EXISTS ram_resources (
      partition TEXT NOT NULL,
      account_id TEXT NOT NULL,
      region TEXT NOT NULL,
      arn TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (partition, account_id, region, arn)
    );
    CREATE TABLE IF NOT EXISTS indexes (
      partition TEXT NOT NULL,
      index_name TEXT NOT NULL,
      data TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (partition, index_name)
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '${CURRENT_SCHEMA_VERSION}');
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('iam-collect_version', ${quote(iamCollectVersion)});
    `
  }

  private init() {
    this.db.exec(SqliteAwsIamStore.schemaSql(this.iamCollectVersion))
  }

  private run(sql: string) {
    this.db.exec(sql)
  }

  private query(sql: string): any[] {
    return this.db.prepare(sql).all()
  }

  private isEmptyContent(content: any): boolean {
    return (
      content === undefined ||
      content === null ||
      content === '' ||
      content === '{}' ||
      content === '[]' ||
      (Array.isArray(content) && content.length === 0) ||
      (typeof content === 'object' && Object.keys(content).length === 0)
    )
  }

  /**
   * Serialize content for storage, preserving string payloads as already-serialized JSON.
   *
   * @param data The content to serialize.
   * @returns The serialized content.
   */
  private serialize(data: any): string {
    return typeof data === 'string' ? data : this.stringifyJson(data)
  }

  async saveResourceMetadata(
    accountId: string,
    arn: string,
    metadataType: string,
    data: string | any
  ): Promise<void> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    metadataType = metadataType.toLowerCase()
    if (this.isEmptyContent(data)) {
      await this.deleteResourceMetadata(accountId, arn, metadataType)
      return
    }
    const parts = splitArnParts(arn)
    const service = (parts.service || '').toLowerCase()
    const region = parts.region ? parts.region.toLowerCase() : null
    const resourceType = parts.resourceType ? parts.resourceType.toLowerCase() : null
    const content = this.serialize(data)
    const arnAccount = parts.accountId
    const sql = `INSERT OR REPLACE INTO resource_metadata(partition, account_id, arn, metadata_type, data, service, region, resource_type, arn_account)
      VALUES(${quote(this.partition)}, ${quote(accountId)}, ${quote(arn)}, ${quote(metadataType)}, ${quote(content)}, ${quote(service)}, ${quote(region)}, ${quote(resourceType)}, ${quote(arnAccount)})`
    this.run(sql)
  }

  async listResourceMetadata(accountId: string, arn: string): Promise<string[]> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    const rows = this.query(
      `SELECT metadata_type FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND arn=${quote(arn)}`
    )
    return rows.map((r) => r.metadata_type)
  }

  async getResourceMetadata<T, D extends T>(
    accountId: string,
    arn: string,
    metadataType: string,
    defaultValue?: D
  ): Promise<D extends undefined ? T | undefined : T> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const rows = this.query(
      `SELECT data FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND arn=${quote(arn)} AND metadata_type=${quote(metadataType)} LIMIT 1`
    )
    if (rows.length === 0) {
      return defaultValue as any
    }
    return JSON.parse(rows[0].data)
  }

  async deleteResourceMetadata(
    accountId: string,
    arn: string,
    metadataType: string
  ): Promise<void> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const sql = `DELETE FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND arn=${quote(arn)} AND metadata_type=${quote(metadataType)}`
    this.run(sql)
  }

  async deleteResource(accountId: string, arn: string): Promise<void> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    const sql = `DELETE FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND arn=${quote(arn)}`
    this.run(sql)
  }

  async listResources(accountId: string, options: ResourceTypeParts): Promise<string[]> {
    accountId = accountId.toLowerCase()
    let sql = `SELECT DISTINCT arn FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND service=${quote(options.service.toLowerCase())}`
    if (options.region) {
      sql += ` AND region=${quote(options.region.toLowerCase())}`
    } else {
      sql += ` AND region IS NULL`
    }
    if (options.resourceType) {
      sql += ` AND resource_type=${quote(options.resourceType.toLowerCase())}`
    } else {
      sql += ` AND resource_type IS NULL`
    }
    if (options.account) {
      sql += ` AND arn_account=${quote(options.account.toLowerCase())}`
    } else {
      sql += ` AND arn_account IS NULL`
    }
    const rows = this.query(sql)
    return rows.map((r) => r.arn)
  }

  async findResourceMetadata<T>(accountId: string, options: ResourceTypeParts): Promise<T[]> {
    accountId = accountId.toLowerCase()
    let sql = `SELECT data FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND service=${quote(options.service.toLowerCase())} AND metadata_type='metadata'`
    if (options.region && options.region !== '*') {
      sql += ` AND region=${quote(options.region.toLowerCase())}`
    }
    if (options.resourceType) {
      sql += ` AND resource_type=${quote(options.resourceType.toLowerCase())}`
    }
    if (options.account) {
      sql += ` AND arn_account=${quote(options.account.toLowerCase())}`
    }

    // Add JSON-based filtering for metadata if provided
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        sql += ` AND json_extract(data, ${quote('$.' + key)}) = ${quote(value)}`
      }
    }

    const rows = this.query(sql)
    const results = rows.map((r) => JSON.parse(r.data))
    return results as T[]
  }

  async syncResourceList(
    accountId: string,
    options: ResourceTypeParts,
    desiredResources: string[]
  ): Promise<void> {
    accountId = accountId.toLowerCase()
    let sql = `SELECT DISTINCT arn, data FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND service=${quote(options.service.toLowerCase())} AND metadata_type='metadata'`
    if (options.region) {
      sql += ` AND region=${quote(options.region.toLowerCase())}`
    }
    if (options.resourceType) {
      sql += ` AND resource_type=${quote(options.resourceType.toLowerCase())}`
    }
    if (options.account) {
      sql += ` AND arn_account=${quote(options.account.toLowerCase())}`
    }

    const rows = this.query(sql)
    let existing = rows.map((r) => ({ arn: r.arn, data: JSON.parse(r.data) }))
    if (options.metadata) {
      existing = existing.filter((item) =>
        Object.entries(options.metadata!).every(([k, v]) => item.data[k] === v)
      )
    }
    const keep = new Set(desiredResources.map((r) => r.toLowerCase()))
    for (const row of existing) {
      if (!keep.has(row.arn.toLowerCase())) {
        const delSql = `DELETE FROM resource_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND arn=${quote(row.arn)}`
        this.run(delSql)
      }
    }
  }

  async deleteAccountMetadata(accountId: string, metadataType: string): Promise<void> {
    accountId = accountId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const sql = `DELETE FROM account_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND metadata_type=${quote(metadataType)}`
    this.run(sql)
  }

  async saveAccountMetadata(accountId: string, metadataType: string, data: any): Promise<void> {
    accountId = accountId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    if (this.isEmptyContent(data)) {
      await this.deleteAccountMetadata(accountId, metadataType)
      return
    }
    const content = this.serialize(data)
    const sql = `INSERT OR REPLACE INTO account_metadata(partition, account_id, metadata_type, data)
      VALUES(${quote(this.partition)}, ${quote(accountId)}, ${quote(metadataType)}, ${quote(content)})`
    this.run(sql)
  }

  async getAccountMetadata<T, D extends T>(
    accountId: string,
    metadataType: string,
    defaultValue?: D
  ): Promise<D extends undefined ? T | undefined : T> {
    accountId = accountId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const rows = this.query(
      `SELECT data FROM account_metadata WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND metadata_type=${quote(metadataType)} LIMIT 1`
    )
    if (rows.length === 0) {
      return defaultValue as any
    }
    return JSON.parse(rows[0].data)
  }

  async getOrganizationMetadata<T, D extends T>(
    organizationId: string,
    metadataType: string,
    defaultValue?: D
  ): Promise<D extends undefined ? T | undefined : T> {
    organizationId = organizationId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const rows = this.query(
      `SELECT data FROM organization_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND metadata_type=${quote(metadataType)} LIMIT 1`
    )
    if (rows.length === 0) {
      return defaultValue as any
    }
    return JSON.parse(rows[0].data)
  }

  async saveOrganizationMetadata(
    organizationId: string,
    metadataType: string,
    data: any
  ): Promise<void> {
    organizationId = organizationId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    if (this.isEmptyContent(data)) {
      await this.deleteOrganizationMetadata(organizationId, metadataType)
      return
    }
    const content = this.serialize(data)
    const sql = `INSERT OR REPLACE INTO organization_metadata(partition, organization_id, metadata_type, data)
      VALUES(${quote(this.partition)}, ${quote(organizationId)}, ${quote(metadataType)}, ${quote(content)})`
    this.run(sql)
  }

  async deleteOrganizationMetadata(organizationId: string, metadataType: string): Promise<void> {
    organizationId = organizationId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const sql = `DELETE FROM organization_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND metadata_type=${quote(metadataType)}`
    this.run(sql)
  }

  async listOrganizationalUnits(organizationId: string): Promise<string[]> {
    organizationId = organizationId.toLowerCase()
    const rows = this.query(
      `SELECT DISTINCT ou_id FROM organizational_unit_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)}`
    )
    return rows.map((r) => r.ou_id)
  }

  async deleteOrganizationalUnitMetadata(
    organizationId: string,
    ouId: string,
    metadataType: string
  ): Promise<void> {
    organizationId = organizationId.toLowerCase()
    ouId = ouId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const sql = `DELETE FROM organizational_unit_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND ou_id=${quote(ouId)} AND metadata_type=${quote(metadataType)}`
    this.run(sql)
  }

  async saveOrganizationalUnitMetadata(
    organizationId: string,
    ouId: string,
    metadataType: string,
    data: any
  ): Promise<void> {
    organizationId = organizationId.toLowerCase()
    ouId = ouId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    if (this.isEmptyContent(data)) {
      await this.deleteOrganizationalUnitMetadata(organizationId, ouId, metadataType)
      return
    }
    const content = this.serialize(data)
    const sql = `INSERT OR REPLACE INTO organizational_unit_metadata(partition, organization_id, ou_id, metadata_type, data)
      VALUES(${quote(this.partition)}, ${quote(organizationId)}, ${quote(ouId)}, ${quote(metadataType)}, ${quote(content)})`
    this.run(sql)
  }

  async getOrganizationalUnitMetadata<T, D extends T>(
    organizationId: string,
    ouId: string,
    metadataType: string,
    defaultValue?: D
  ): Promise<D extends undefined ? T | undefined : T> {
    organizationId = organizationId.toLowerCase()
    ouId = ouId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const rows = this.query(
      `SELECT data FROM organizational_unit_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND ou_id=${quote(ouId)} AND metadata_type=${quote(metadataType)} LIMIT 1`
    )
    if (rows.length === 0) {
      return defaultValue as any
    }
    return JSON.parse(rows[0].data)
  }

  async deleteOrganizationalUnit(organizationId: string, ouId: string): Promise<void> {
    organizationId = organizationId.toLowerCase()
    ouId = ouId.toLowerCase()
    const sql = `DELETE FROM organizational_unit_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND ou_id=${quote(ouId)}`
    this.run(sql)
  }

  async deleteOrganizationPolicyMetadata(
    organizationId: string,
    policyType: OrganizationPolicyType,
    policyId: string,
    metadataType: string
  ): Promise<void> {
    organizationId = organizationId.toLowerCase()
    policyType = policyType.toLowerCase() as OrganizationPolicyType
    policyId = policyId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const sql = `DELETE FROM organization_policy_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND policy_type=${quote(policyType)} AND policy_id=${quote(policyId)} AND metadata_type=${quote(metadataType)}`
    this.run(sql)
  }

  async saveOrganizationPolicyMetadata(
    organizationId: string,
    policyType: OrganizationPolicyType,
    policyId: string,
    metadataType: string,
    data: any
  ): Promise<void> {
    organizationId = organizationId.toLowerCase()
    policyType = policyType.toLowerCase() as OrganizationPolicyType
    policyId = policyId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    if (this.isEmptyContent(data)) {
      await this.deleteOrganizationPolicyMetadata(
        organizationId,
        policyType,
        policyId,
        metadataType
      )
      return
    }
    const content = this.serialize(data)
    const sql = `INSERT OR REPLACE INTO organization_policy_metadata(partition, organization_id, policy_type, policy_id, metadata_type, data)
      VALUES(${quote(this.partition)}, ${quote(organizationId)}, ${quote(policyType)}, ${quote(policyId)}, ${quote(metadataType)}, ${quote(content)})`
    this.run(sql)
  }

  async getOrganizationPolicyMetadata<T, D extends T>(
    organizationId: string,
    policyType: OrganizationPolicyType,
    policyId: string,
    metadataType: string,
    defaultValue?: D
  ): Promise<D extends undefined ? T | undefined : T> {
    organizationId = organizationId.toLowerCase()
    policyType = policyType.toLowerCase() as OrganizationPolicyType
    policyId = policyId.toLowerCase()
    metadataType = metadataType.toLowerCase()
    const rows = this.query(
      `SELECT data FROM organization_policy_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND policy_type=${quote(policyType)} AND policy_id=${quote(policyId)} AND metadata_type=${quote(metadataType)} LIMIT 1`
    )
    if (rows.length === 0) {
      return defaultValue as any
    }
    return JSON.parse(rows[0].data)
  }

  async deleteOrganizationPolicy(
    organizationId: string,
    policyType: OrganizationPolicyType,
    policyId: string
  ): Promise<void> {
    organizationId = organizationId.toLowerCase()
    policyType = policyType.toLowerCase() as OrganizationPolicyType
    policyId = policyId.toLowerCase()
    const sql = `DELETE FROM organization_policy_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND policy_type=${quote(policyType)} AND policy_id=${quote(policyId)}`
    this.run(sql)
  }

  async listOrganizationPolicies(
    organizationId: string,
    policyType: OrganizationPolicyType
  ): Promise<string[]> {
    organizationId = organizationId.toLowerCase()
    policyType = policyType.toLowerCase() as OrganizationPolicyType
    const rows = this.query(
      `SELECT DISTINCT policy_id FROM organization_policy_metadata WHERE partition=${quote(this.partition)} AND organization_id=${quote(organizationId)} AND policy_type=${quote(policyType)}`
    )
    return rows.map((r) => r.policy_id)
  }

  async syncRamResources(
    accountId: string,
    region: string | undefined,
    arns: string[]
  ): Promise<void> {
    accountId = accountId.toLowerCase()
    const rg = region && region.trim() !== '' ? region.toLowerCase() : 'global'
    const rows = this.query(
      `SELECT arn FROM ram_resources WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND region=${quote(rg)}`
    )
    const keep = new Set(arns.map((a) => a.toLowerCase()))
    for (const row of rows) {
      if (!keep.has(row.arn.toLowerCase())) {
        const delSql = `DELETE FROM ram_resources WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND region=${quote(rg)} AND arn=${quote(row.arn)}`
        this.run(delSql)
      }
    }
  }

  async saveRamResource(accountId: string, arn: string, data: any): Promise<void> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    const region = splitArnParts(arn).region
    const rg = region && region.trim() !== '' ? region.toLowerCase() : 'global'
    const content = this.serialize(data)
    const sql = `INSERT OR REPLACE INTO ram_resources(partition, account_id, region, arn, data)
      VALUES(${quote(this.partition)}, ${quote(accountId)}, ${quote(rg)}, ${quote(arn)}, ${quote(content)})`
    this.run(sql)
  }

  async getRamResource<T, D extends T>(
    accountId: string,
    arn: string,
    defaultValue?: D
  ): Promise<D extends undefined ? T | undefined : T> {
    accountId = accountId.toLowerCase()
    arn = arn.toLowerCase()
    const region = splitArnParts(arn).region
    const rg = region && region.trim() !== '' ? region.toLowerCase() : 'global'
    const rows = this.query(
      `SELECT data FROM ram_resources WHERE partition=${quote(this.partition)} AND account_id=${quote(accountId)} AND region=${quote(rg)} AND arn=${quote(arn)} LIMIT 1`
    )
    if (rows.length === 0) {
      return defaultValue as any
    }
    return JSON.parse(rows[0].data)
  }

  async listAccountIds(): Promise<string[]> {
    const rows = this.query(
      `SELECT DISTINCT account_id FROM resource_metadata WHERE partition=${quote(this.partition)}`
    )
    return rows.map((r) => r.account_id)
  }

  async getIndex<T>(indexName: string, defaultValue: T): Promise<{ data: T; lockId: string }> {
    const rows = this.query(
      `SELECT data, hash FROM indexes WHERE partition=${quote(this.partition)} AND index_name=${quote(indexName.toLowerCase())} LIMIT 1`
    )
    if (rows.length === 0) {
      return { data: defaultValue, lockId: '' }
    }
    return { data: JSON.parse(rows[0].data), lockId: rows[0].hash }
  }

  async saveIndex<T>(indexName: string, data: T, lockId: string): Promise<boolean> {
    const existing = this.query(
      `SELECT hash FROM indexes WHERE partition=${quote(this.partition)} AND index_name=${quote(indexName.toLowerCase())} LIMIT 1`
    )
    if (existing.length > 0 && existing[0].hash !== lockId) {
      return false
    }
    if (existing.length === 0 && lockId !== '') {
      return false
    }
    const content = this.stringifyJson(data)
    const hash = createHash('sha256').update(content).digest('hex')
    const sql = `INSERT OR REPLACE INTO indexes(partition, index_name, data, hash)
      VALUES(${quote(this.partition)}, ${quote(indexName.toLowerCase())}, ${quote(content)}, ${quote(hash)})`
    this.run(sql)
    return true
  }
}
