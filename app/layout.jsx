import './globals.css';

export const metadata = {
  title: 'StreamChain Node 0',
  description: 'Bootstrap read-only node for StreamChain on Vercel with zero initial cost.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
