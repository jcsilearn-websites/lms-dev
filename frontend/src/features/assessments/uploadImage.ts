import { ApiError } from '../../shared/api/client';
import { confirmUpload, requestCourseUpload } from './assessments.api';

/** Uploads ONE image for a question of a course: signed URL, the bytes straight to it (with progress), then confirm. */
export async function uploadQuestionImage(
  courseId: string,
  file: File,
  onProgress: (fraction: number) => void,
) {
  const req = await requestCourseUpload(courseId, file.name, file.size);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', req.upload.url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-requested-with', 'lms');
    for (const [k, v] of Object.entries(req.upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = 'The upload failed.';
      try {
        message =
          (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ??
          message;
      } catch {
        // not JSON: keep the generic message
      }
      reject(new ApiError(xhr.status, 'upload_failed', message));
    };
    xhr.onerror = () =>
      reject(
        new ApiError(0, 'network_error', 'The upload was interrupted. Check your connection.'),
      );
    xhr.send(file);
  });
  onProgress(1);
  return confirmUpload(req.file.id);
}
