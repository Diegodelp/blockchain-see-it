import { FullNodeWeb } from '@/components/full-node-web';
import { Node0LandingPage } from '@/components/node0-pages';
import { getAppState } from '@/lib/app-state';

export default async function HomePage() {
  const appState = await getAppState();
  return (
    <main className="pageShell">
      {appState.mode === 'self-hosted' ? (
        <FullNodeWeb initialState={appState.state} />
      ) : (
        <Node0LandingPage state={appState.state} references={appState.references} />
      )}
    </main>
  );
}
