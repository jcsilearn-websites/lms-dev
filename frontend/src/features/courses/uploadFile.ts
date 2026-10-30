import type { FileDto } from '@lms/backend/contracts';
import { ApiError } from '../../shared/api/client';
import { confirmUpload, requestUpload } from './courses.api';

/**
 * Uploads ONE file to an offering: asks for a signed URL, PUTs the bytes straight to it (XMLHttpRequest, because
 * `fetch` cannot report upload progress), then asks the server to confirm (it reads the bytes and checks size and
 * type). `onProgress` gets 0..1 while the bytes travel. Aborting the signal cancels the transfer.
 */
export async function uploadFile(
  offeringId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<FileDto> {
  const req = await requestUpload(offeringId, file.name, file.size);
  await put(req.upload.url, req.upload.headers, file, onProgress, signal);
  onProgress(1);
  return confirmUpload(req.file.id);
}

function put(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    // the same CSRF header as every other mutation (the local storage driver checks it; a cloud URL ignores it)
    xhr.setRequestHeader('x-requested-with', 'lms');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let code = 'upload_failed';
      let message = 'The upload failed.';
      try {
        const body = JSON.parse(xhr.responseText) as {
          error?: { code?: string; message?: string };
        };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // not JSON: keep the generic message
      }
      reject(new ApiError(xhr.status, code, message));
    };
    xhr.onerror = () =>
      reject(
        new ApiError(0, 'network_error', 'The upload was interrupted. Check your connection.'),
      );
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
