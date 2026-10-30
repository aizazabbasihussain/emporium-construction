import { Button } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The install event Chrome and Edge fire; it is not in the standard DOM typings. */
interface InstallEvent extends Event {
  prompt(): Promise<void>;
}

/** BR-1: offers to install the app once the browser says it can. */
export function InstallPrompt() {
  const { t } = useTranslation();
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (event === null) return null;
  return (
    <Button
      size="small"
      onClick={() => {
        void event.prompt();
        setEvent(null);
      }}
    >
      {t('offline.install')}
    </Button>
  );
}
