import { db } from '../db';

export async function safeDbInsert<T>(
  tableName: string,
  operation: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T | null> {
  const logPrefix = `[DB INSERT ${tableName}]`;
  console.log(`${logPrefix} Attempting insert...`, metadata ? JSON.stringify(metadata).substring(0, 200) : '');
  
  try {
    const result = await operation();
    console.log(`${logPrefix} SUCCESS`, metadata?.id ? `id: ${metadata.id}` : '');
    return result;
  } catch (error: any) {
    console.error(`${logPrefix} FAILED:`, error.message);
    console.error(`${logPrefix} Stack:`, error.stack?.substring(0, 500));
    console.error(`${logPrefix} Metadata:`, JSON.stringify(metadata || {}).substring(0, 500));
    return null;
  }
}

export async function safeDbUpdate<T>(
  tableName: string,
  operation: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T | null> {
  const logPrefix = `[DB UPDATE ${tableName}]`;
  console.log(`${logPrefix} Attempting update...`, metadata ? JSON.stringify(metadata).substring(0, 200) : '');
  
  try {
    const result = await operation();
    console.log(`${logPrefix} SUCCESS`, metadata?.id ? `id: ${metadata.id}` : '');
    return result;
  } catch (error: any) {
    console.error(`${logPrefix} FAILED:`, error.message);
    console.error(`${logPrefix} Stack:`, error.stack?.substring(0, 500));
    console.error(`${logPrefix} Metadata:`, JSON.stringify(metadata || {}).substring(0, 500));
    return null;
  }
}

export async function safeDbInsertRequired<T>(
  tableName: string,
  operation: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  const logPrefix = `[DB INSERT ${tableName}]`;
  console.log(`${logPrefix} Attempting required insert...`, metadata ? JSON.stringify(metadata).substring(0, 200) : '');
  
  try {
    const result = await operation();
    console.log(`${logPrefix} SUCCESS`, metadata?.id ? `id: ${metadata.id}` : '');
    return result;
  } catch (error: any) {
    console.error(`${logPrefix} REQUIRED INSERT FAILED:`, error.message);
    console.error(`${logPrefix} Stack:`, error.stack?.substring(0, 500));
    console.error(`${logPrefix} Metadata:`, JSON.stringify(metadata || {}).substring(0, 500));
    throw new Error(`Database insert failed for ${tableName}: ${error.message}`);
  }
}

export async function safeDbUpdateRequired<T>(
  tableName: string,
  operation: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  const logPrefix = `[DB UPDATE ${tableName}]`;
  console.log(`${logPrefix} Attempting required update...`, metadata ? JSON.stringify(metadata).substring(0, 200) : '');
  
  try {
    const result = await operation();
    console.log(`${logPrefix} SUCCESS`, metadata?.id ? `id: ${metadata.id}` : '');
    return result;
  } catch (error: any) {
    console.error(`${logPrefix} REQUIRED UPDATE FAILED:`, error.message);
    console.error(`${logPrefix} Stack:`, error.stack?.substring(0, 500));
    console.error(`${logPrefix} Metadata:`, JSON.stringify(metadata || {}).substring(0, 500));
    throw new Error(`Database update failed for ${tableName}: ${error.message}`);
  }
}

export async function testDbConnection(): Promise<boolean> {
  console.log('[DB] Testing database connection...');
  try {
    const result = await db.execute('SELECT 1 as test');
    console.log('[DB] Connection test SUCCESS');
    return true;
  } catch (error: any) {
    console.error('[DB] Connection test FAILED:', error.message);
    return false;
  }
}
