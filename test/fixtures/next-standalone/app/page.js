export const dynamic = 'force-dynamic';
export default function Page() {
  return (<main><h1>{process.env.GREETING}</h1><p>render: {new Date().toISOString()}</p></main>);
}
