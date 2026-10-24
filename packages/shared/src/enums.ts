export const fileStoreDrivers = ['supabase', 'local'] as const;
export type FileStoreDriver = (typeof fileStoreDrivers)[number];
