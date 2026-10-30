import { rawRequest, request } from '../admin/api';

export interface Attachment {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  caption: string | null;
  takenAt: string | null;
  version: number;
}

export const filesApi = {
  list: (entityType: string, entityId: string) =>
    request<{ items: Attachment[] }>(
      'GET',
      `/files?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`,
    ),
  upload: async (
    entityType: string,
    entityId: string,
    file: File,
    caption: string,
    idempotencyKey?: string,
  ): Promise<Attachment> => {
    const form = new FormData();
    form.append('entityType', entityType);
    form.append('entityId', entityId);
    if (caption.trim() !== '') form.append('caption', caption.trim());
    if (file.lastModified > 0) form.append('takenAt', new Date(file.lastModified).toISOString());
    form.append('file', file, file.name);
    return (await (await rawRequest('POST', '/files', form, idempotencyKey)).json()) as Attachment;
  },
  url: (id: string) => request<{ url: string; expiresAt: string }>('GET', `/files/${id}/url`),
  remove: (id: string, version: number) =>
    request<Attachment>('DELETE', `/files/${id}?version=${version}`),
};
