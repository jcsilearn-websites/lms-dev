import { useState } from 'react';
import { Button } from '../../shared/ui/button';

/**
 * The recovery codes, shown ONCE (the server keeps only keyed hashes): copy, download, and an explicit "I saved them"
 * before they leave the screen.
 */
export function RecoveryCodes({
  codes,
  doneLabel,
  onDone,
}: {
  codes: string[];
  doneLabel: string;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const text = `${codes.join('\n')}\n`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied. Paste them somewhere safe.');
    } catch {
      setCopied('Copying was blocked by the browser: download them, or write them down.');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Your recovery codes</h2>
      <p className="text-sm">
        Each code signs you in once if you lose your phone. <strong>They are shown only now</strong>
        : keep them somewhere safe, away from the phone.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 font-mono text-sm"
      >
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={copy}>
          Copy
        </Button>
        <Button variant="secondary" onClick={download}>
          Download
        </Button>
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {copied}
      </p>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I have saved these codes
      </label>
      <Button className="w-full" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
