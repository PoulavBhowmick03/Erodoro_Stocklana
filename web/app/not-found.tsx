import Link from "next/link";

import { Nav } from "@/components/nav";

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="mx-auto flex min-h-[70vh] w-full max-w-6xl flex-1 items-center px-6 py-20">
        <section className="border-line grid w-full gap-8 border-y py-12 md:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="text-accent-ink font-mono text-[0.8125rem] tracking-[0.14em] uppercase">404 · Not found</div>
          <div>
            <h1 className="max-w-[16ch] text-5xl font-medium tracking-[-0.05em] sm:text-6xl">This market does not exist.</h1>
            <p className="text-muted mt-5 max-w-xl text-base leading-7">The link may be old, incomplete or connected to another network. Return to the market directory to choose an available series.</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/app" className="bg-text hover:bg-accent text-bg rounded-sm px-4 py-2.5 text-sm transition-colors">Browse markets</Link>
              <Link href="/" className="border-line hover:border-text rounded-sm border px-4 py-2.5 text-sm transition-colors">Back to Erodoro</Link>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
