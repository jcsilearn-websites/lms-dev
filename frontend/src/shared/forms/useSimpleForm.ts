import { type ChangeEvent, type FormEvent, useCallback, useRef, useState } from 'react';

// A deliberately tiny form hook for the PUBLIC auth screens (login, forgot/reset password, accept
// invite): 1-2 text fields each. The signed-in screens use react-hook-form instead; keeping it out
// of the public pages saves ~12 KB gzip on the login page (the budget is in docs/benchmarks.md).
//
// Validation is a lazily loaded function (TypeBox + contracts live in a separate chunk): it is
// requested on the first focus of a field, so it is normally ready by the time the person submits.

export type Validator = (values: Record<string, string>) => Record<string, string>;

export function useSimpleForm<V extends Record<string, string>>(opts: {
  initial: V;
  loadValidator: () => Promise<Validator>;
  onSubmit: (values: V) => Promise<void>;
}) {
  const [values, setValues] = useState<V>(opts.initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const validatorRef = useRef<Promise<Validator> | null>(null);

  const preload = useCallback(() => {
    validatorRef.current ??= opts.loadValidator();
    return validatorRef.current;
  }, [opts.loadValidator]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement; // read before the first await
    if (submitting) return;
    const found = (await preload())(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // move focus to the first invalid field so keyboard and screen-reader users land on it
      const first = Object.keys(found)[0];
      (form.elements.namedItem(first as string) as HTMLElement | null)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await opts.onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  };

  const field = (name: keyof V & string) => ({
    name,
    value: values[name],
    onFocus: () => void preload(),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setValues((v) => ({ ...v, [name]: value }));
      setErrors((prev) => {
        if (!prev[name]) return prev;
        const { [name]: _removed, ...rest } = prev;
        return rest;
      });
    },
    'aria-invalid': errors[name] ? (true as const) : undefined,
    'aria-describedby': errors[name] ? `${name}-error` : undefined,
  });

  return { values, errors, submitting, submit, field, setErrors };
}
