import { Router } from './router';

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '3rem auto' }}>
      <h1>JCS iLearn</h1>
      <Router />
    </main>
  );
}
