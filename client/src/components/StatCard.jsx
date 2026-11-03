export default function StatCard({ icon, label, value, suffix, accent = 'leaf' }) {
  const bg =
    accent === 'sky'
      ? 'from-sky-50 to-white border-sky-100'
      : accent === 'amber'
        ? 'from-amber-50 to-white border-amber-100'
        : 'from-leaf-50 to-white border-leaf-100';

  return (
    <div
      className={`animate-fade-up rounded-2xl border bg-gradient-to-br p-4 shadow-sm ${bg}`}
    >
      <div className="mb-1 text-2xl">{icon}</div>
      <p className="text-2xl font-extrabold text-stone-800">
        {value}
        {suffix && <span className="ml-0.5 text-sm font-bold text-stone-500">{suffix}</span>}
      </p>
      <p className="text-xs font-semibold text-stone-500">{label}</p>
    </div>
  );
}
