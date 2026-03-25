import { Node0NetworkPage } from '@/components/node0-pages';
import { getAppState } from '@/lib/app-state';

export default async function NetworkPage() {
  const appState = await getAppState();
  return (
    <main className="pageShell">
      <Node0NetworkPage state={appState.state} references={appState.references} />
    </main>
  );
}
