import { notification } from 'antd';
import { ApiError } from '../admin/api';
import { i18n } from '../i18n';
import { describeIssue } from './issues';

/**
 * The red pop-up on the right for a failed request. Field problems are listed one per line;
 * other failures show the server's message. Used for every failed save through the query client.
 */
export function notifyError(error: unknown): void {
  if (error instanceof ApiError) {
    if (error.details.length > 0) {
      notification.error({
        key: error.requestId,
        placement: 'topRight',
        duration: 10,
        title: i18n.t('errors.validation.title', { count: error.details.length }),
        description: (
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {error.details.map((issue, index) => (
              <li key={index}>{describeIssue(issue)}</li>
            ))}
          </ul>
        ),
      });
      return;
    }
    notification.error({
      key: error.requestId,
      placement: 'topRight',
      duration: 8,
      title: i18n.t('errors.requestFailed'),
      description: error.message,
    });
    return;
  }
  // fetch() rejects with a TypeError when the server cannot be reached.
  if (error instanceof TypeError) {
    notification.error({
      key: 'network',
      placement: 'topRight',
      title: i18n.t('errors.requestFailed'),
      description: i18n.t('errors.network'),
    });
  }
}
