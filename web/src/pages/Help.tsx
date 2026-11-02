import { HelpChat } from "../components/HelpChat";

export default function Help() {
  return (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-2xl font-semibold">❓ Ask FlipDesk</h1>
      <div className="card p-4"><HelpChat /></div>
    </div>
  );
}
