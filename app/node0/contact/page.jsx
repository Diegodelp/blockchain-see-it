import { Node0ContactPage } from '@/components/node0-pages';
import { getAppState } from '@/lib/app-state';

export default async function ContactPage() {
  const appState = await getAppState();
  return (
    <main className="pageShell">
      <Node0ContactPage state={appState.state} />
    </main>
  );
}
