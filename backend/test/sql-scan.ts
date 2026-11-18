import ts from 'typescript';

// STATIC CHECK: SQL built by STRING CONSTRUCTION (step 14a). Drizzle's `sql` tag turns every ${value} into a bind parameter, so a
// tagged template is safe. What is NOT safe is text assembled by the program and handed to the database as SQL:
//   sql-raw-dynamic        sql.raw(<anything but a string literal>)        raw SQL text from an expression
//   query-dynamic-string   <x>.query(<template with ${} | a + b | a call>) / <x>.execute(...) given a built string
//   untagged-sql-template  an untagged template literal with ${} that reads like SQL (SELECT / INSERT / UPDATE / DELETE / ...)
//   sql-string-concat      'SELECT ... ' + value                           concatenated SQL text
// Every finding must be on the reviewed allowlist (test/sql-concat.allowlist.json) with the reason it is safe. A new one fails the build
// until a reviewer has read it: that is the point.

export interface Finding {
  kind: 'sql-raw-dynamic' | 'query-dynamic-string' | 'untagged-sql-template' | 'sql-string-concat';
  file: string;
  line: number;
  /** the source text of the construct, whitespace collapsed (the allowlist key) */
  text: string;
}

const SQL_WORDS =
  /\b(select|insert\s+into|update|delete\s+from|alter\s+table|create\s+(table|database|role)|drop\s+|truncate|set_config|begin;|grant\s|revoke\s)\b/i;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function scanSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const add = (kind: Finding['kind'], node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ kind, file, line: line + 1, text: norm(node.getText(sf)).slice(0, 220) });
  };
  const isStaticString = (n: ts.Expression): boolean =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // sql.raw(x)
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'raw' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'sql'
      ) {
        const arg = node.arguments[0];
        if (!arg || !isStaticString(arg)) add('sql-raw-dynamic', node);
      }
      // client.query(x) / db.execute(x) with a built string
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'query' || callee.name.text === 'execute')
      ) {
        const arg = node.arguments[0];
        if (arg) {
          const built =
            ts.isTemplateExpression(arg) ||
            (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
            (ts.isCallExpression(arg) &&
              /^(concat|join|replace|format)$/.test(
                ts.isPropertyAccessExpression(arg.expression) ? arg.expression.name.text : '',
              ));
          if (built) add('query-dynamic-string', node);
        }
      }
    }
    // untagged `SELECT ... ${x}`
    if (
      ts.isTemplateExpression(node) &&
      !(node.parent && ts.isTaggedTemplateExpression(node.parent))
    ) {
      const text = node.getText(sf);
      if (SQL_WORDS.test(text) && !isInsideReported(node)) add('untagged-sql-template', node);
    }
    // 'SELECT ...' + x
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = node.left;
      if (
        ts.isStringLiteral(left) &&
        SQL_WORDS.test(left.text) &&
        !ts.isStringLiteral(node.right)
      ) {
        add('sql-string-concat', node);
      }
    }
    ts.forEachChild(node, visit);
  };

  // a template that is the argument of an already reported query() is not reported twice
  const reportedStarts = new Set<number>();
  const isInsideReported = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && reportedStarts.has(p.getStart(sf))) return true;
    }
    return false;
  };
  // first pass marks reported calls so the second does not duplicate
  const pre = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'query' || callee.name.text === 'execute')
      ) {
        const arg = node.arguments[0];
        if (
          arg &&
          (ts.isTemplateExpression(arg) ||
            (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken))
        ) {
          reportedStarts.add(node.getStart(sf));
        }
      }
    }
    ts.forEachChild(node, pre);
  };
  pre(sf);
  visit(sf);
  return out;
}
