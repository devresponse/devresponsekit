import { getBrand } from "@/config/brand";

export default function AboutPage() {
  const brand = getBrand();
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-2xl font-semibold">{brand.name}</h1>
      <p className="text-foreground text-sm">
        {brand.name} Platform — public marketing/landing content goes here.
      </p>
    </main>
  );
}
