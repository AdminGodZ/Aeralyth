export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-3xl">
        <p className="font-display text-sm font-medium uppercase tracking-[0.18em] text-zinc-500">
          Self-hosted cloud
        </p>
        <h1 className="mt-4 font-display text-5xl font-semibold tracking-tight sm:text-7xl">
          Aeralith
        </h1>
        <p className="mt-6 max-w-2xl font-sans text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          A focused file cloud built around simple ownership, fast transfers,
          and a small security surface.
        </p>
      </section>
    </main>
  );
}
