const open = jest.fn();
const drizzle = jest.fn();
const runMigrations = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open }));
jest.mock('drizzle-orm/op-sqlite', () => ({ drizzle }));
jest.mock('@db/migrate', () => ({ runMigrations }));

function rawHandle() {
  type SyncResult = {
    rows: unknown[];
    rowsAffected?: number;
    insertId?: number;
    columnNames?: string[];
  };

  return {
    close: jest.fn(),
    execute: jest.fn<Promise<{ rows: unknown[] }>, [string, unknown[]?]>(async () => ({
      rows: [],
    })),
    executeRaw: jest.fn<Promise<{ rawRows: unknown[][] }>, [string, unknown[]?]>(async () => ({
      rawRows: [],
    })),
    executeSync: jest.fn<SyncResult, [string, unknown[]?]>(() => ({ rows: [] })),
    flushPendingReactiveQueries: jest.fn(),
  };
}

describe('database initialization cleanup', () => {
  beforeEach(() => {
    jest.resetModules();
    open.mockReset();
    drizzle.mockReset();
    runMigrations.mockReset();
  });

  it('closes and forgets a failed handle so a later open can succeed', async () => {
    const failed = rawHandle();
    const healthy = rawHandle();
    const database = { kind: 'healthy-db' };
    open.mockReturnValueOnce(failed).mockReturnValueOnce(healthy);
    runMigrations.mockRejectedValueOnce(new Error('migration failed')).mockResolvedValueOnce([]);
    drizzle.mockReturnValue(database);

    const { getRawDatabase, initDatabase } = await import('@db/database');

    await expect(initDatabase('wrong-key')).rejects.toThrow('migration failed');
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(() => getRawDatabase()).toThrow('Database not initialized');

    await expect(initDatabase('correct-key')).resolves.toBe(database);
    expect(open).toHaveBeenNthCalledWith(2, { name: 'gator.db', encryptionKey: 'correct-key' });
    expect(healthy.close).not.toHaveBeenCalled();
    expect(getRawDatabase()).toBe(healthy);
  });

  it('preserves the original failure if closing the unusable handle also throws', async () => {
    const failed = rawHandle();
    failed.close.mockImplementation(() => {
      throw new Error('close failed');
    });
    open.mockReturnValueOnce(failed);
    runMigrations.mockRejectedValueOnce(new Error('wrong key'));

    const { getRawDatabase, initDatabase } = await import('@db/database');

    await expect(initDatabase('wrong-key')).rejects.toThrow('wrong key');
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(() => getRawDatabase()).toThrow('Database not initialized');
  });

  it('closes and forgets a handle when the foreign-key PRAGMA fails, then retries', async () => {
    const failed = rawHandle();
    const healthy = rawHandle();
    const database = { kind: 'healthy-db' };
    failed.execute.mockRejectedValueOnce(new Error('foreign-key PRAGMA failed'));
    open.mockReturnValueOnce(failed).mockReturnValueOnce(healthy);
    runMigrations.mockResolvedValue([]);
    drizzle.mockReturnValue(database);

    const { getRawDatabase, initDatabase } = await import('@db/database');

    await expect(initDatabase('first-key')).rejects.toThrow('foreign-key PRAGMA failed');
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(() => getRawDatabase()).toThrow('Database not initialized');

    await expect(initDatabase('second-key')).resolves.toBe(database);
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(getRawDatabase()).toBe(healthy);
  });

  it('publishes neither handle until migrations and Drizzle construction finish', async () => {
    const opened = rawHandle();
    const database = { kind: 'published-db' };
    let releaseMigration!: () => void;
    const migrationGate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    let migrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      migrationStarted = resolve;
    });
    open.mockReturnValueOnce(opened);
    runMigrations.mockImplementationOnce(async () => {
      migrationStarted();
      await migrationGate;
    });
    drizzle.mockReturnValueOnce(database);

    const { getDatabase, getRawDatabase, initDatabase } = await import('@db/database');
    const opening = initDatabase('correct-key');
    await started;

    expect(() => getRawDatabase()).toThrow('Database not initialized');
    expect(() => getDatabase()).toThrow('Database not initialized');
    expect(drizzle).not.toHaveBeenCalled();

    releaseMigration();
    await expect(opening).resolves.toBe(database);
    expect(getRawDatabase()).toBe(opened);
    expect(getDatabase()).toBe(database);
  });

  it('forwards the migration runner and all three Drizzle adapter methods to one raw handle', async () => {
    const opened = rawHandle();
    const database = { kind: 'adapted-db' };
    const migrationRows = [{ name: '0001_initial' }];
    const syncRows = [{ id: 'sync' }];
    const asyncRows = [{ id: 'async' }];
    const rawRows = [['raw']];
    opened.execute.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT migration') return { rows: migrationRows };
      if (sql === 'adapter async') return { rows: asyncRows };
      return { rows: [] };
    });
    opened.executeSync.mockReturnValue({
      rows: syncRows,
      rowsAffected: 2,
      insertId: 7,
      columnNames: ['id'],
    });
    opened.executeRaw.mockResolvedValue({ rawRows });
    open.mockReturnValueOnce(opened);

    runMigrations.mockImplementationOnce(
      async (runner: {
        exec(sql: string, params?: unknown[]): Promise<void>;
        query<T>(sql: string, params?: unknown[]): Promise<T[]>;
      }) => {
        await runner.exec('migration write', ['write-param']);
        await expect(runner.query('SELECT migration', ['read-param'])).resolves.toEqual(
          migrationRows,
        );
      },
    );

    type AdaptedHandle = {
      execute(sql: string, params?: unknown[]): { rows: { _array: unknown[] } };
      executeAsync(sql: string, params?: unknown[]): Promise<{ rows: { _array: unknown[] } }>;
      executeRawAsync(sql: string, params?: unknown[]): Promise<unknown[][]>;
    };
    let adapted!: AdaptedHandle;
    drizzle.mockImplementationOnce((value: AdaptedHandle) => {
      adapted = value;
      return database;
    });

    const { initDatabase } = await import('@db/database');
    await expect(initDatabase('correct-key')).resolves.toBe(database);

    expect(opened.execute).toHaveBeenCalledWith('migration write', ['write-param']);
    expect(opened.execute).toHaveBeenCalledWith('SELECT migration', ['read-param']);

    expect(adapted.execute('adapter sync', ['sync-param'])).toEqual({
      rowsAffected: 2,
      insertId: 7,
      columnNames: ['id'],
      rows: { _array: syncRows },
    });
    expect(opened.executeSync.mock.invocationCallOrder[0]).toBeLessThan(
      opened.flushPendingReactiveQueries.mock.invocationCallOrder[0]!,
    );
    await expect(adapted.executeAsync('adapter async', ['async-param'])).resolves.toEqual({
      rows: { _array: asyncRows },
    });
    await expect(adapted.executeRawAsync('adapter raw', ['raw-param'])).resolves.toEqual(rawRows);

    expect(opened.executeSync).toHaveBeenCalledWith('adapter sync', ['sync-param']);
    expect(opened.execute).toHaveBeenCalledWith('adapter async', ['async-param']);
    expect(opened.executeRaw).toHaveBeenCalledWith('adapter raw', ['raw-param']);
    expect(opened.flushPendingReactiveQueries).toHaveBeenCalledTimes(3);

    opened.executeSync.mockImplementationOnce(() => {
      throw new Error('sync execution failed');
    });
    opened.flushPendingReactiveQueries.mockClear();
    expect(() => adapted.execute('adapter broken')).toThrow('sync execution failed');
    expect(opened.flushPendingReactiveQueries).not.toHaveBeenCalled();
  });

  it('closes and forgets a handle when Drizzle construction fails, then retries cleanly', async () => {
    const failed = rawHandle();
    const healthy = rawHandle();
    const database = { kind: 'healthy-db' };
    open.mockReturnValueOnce(failed).mockReturnValueOnce(healthy);
    runMigrations.mockResolvedValue([]);
    drizzle.mockImplementationOnce(() => {
      throw new Error('adapter construction failed');
    });
    drizzle.mockReturnValueOnce(database);

    const { getDatabase, getRawDatabase, initDatabase } = await import('@db/database');

    await expect(initDatabase('first-key')).rejects.toThrow('adapter construction failed');
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(() => getRawDatabase()).toThrow('Database not initialized');
    expect(() => getDatabase()).toThrow('Database not initialized');

    await expect(initDatabase('second-key')).resolves.toBe(database);
    expect(getRawDatabase()).toBe(healthy);
    expect(getDatabase()).toBe(database);
  });
});
