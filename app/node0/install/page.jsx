import { Node0InstallPage } from '@/components/node0-pages';
import { getAppState } from '@/lib/app-state';

export default async function InstallPage() {
  const appState = await getAppState();
  return (
    <main className="pageShell">
      <Node0InstallPage state={appState.state} />
    </main>
  );
}
