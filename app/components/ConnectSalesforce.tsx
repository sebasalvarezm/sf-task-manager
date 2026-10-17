"use client";

type Props = {
  connected: boolean;
  onDisconnect: () => void;
};

export default function ConnectSalesforce({ connected, onDisconnect }: Props) {
  if (connected) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 text-sm text-ok bg-ok-soft rounded-sm px-2 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-ok inline-block"></span>
          Salesforce connected
        </span>
        <button
          onClick={onDisconnect}
          className="text-xs text-gray-400 hover:text-red-500 underline"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <a
      href="/api/salesforce/connect"
      className="flex items-center gap-2 bg-white border border-line-strong hover:bg-surface-3 text-ink text-sm font-medium px-4 h-9 rounded-sm transition-colors"
    >
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
        <path d="M13.78 4.22a.75.75 0 010 1.06L7.06 12l6.72 6.72a.75.75 0 11-1.06 1.06l-7.25-7.25a.75.75 0 010-1.06l7.25-7.25a.75.75 0 011.06 0z" />
      </svg>
      Connect Salesforce
    </a>
  );
}
