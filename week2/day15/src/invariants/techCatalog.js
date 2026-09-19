/**
 * Technologies the rule-based invariant checker recognises.
 *
 * Each entry belongs to a group; two technologies of the same group are
 * alternatives (Node.js vs Python, PostgreSQL vs MongoDB). `implies` links a
 * framework to its language, so "use Django" also counts as "use Python".
 * `fences` are Markdown code-fence languages that reveal the technology in a
 * generated answer.
 *
 * Patterns are matched case-insensitively unless `caseSensitive` is set.
 */
export const GROUP_LABELS = Object.freeze({
  language: 'programming language / runtime',
  framework: 'backend framework',
  database: 'database',
  cache: 'cache / key-value store',
  frontend: 'frontend framework',
  architecture: 'architecture style',
  api: 'API style',
});

export const TECHNOLOGIES = Object.freeze([
  // --- Languages and runtimes -------------------------------------------------
  { id: 'javascript', label: 'Node.js / JavaScript', group: 'language',
    patterns: [/\bnode\.?js\b/, /\bnode (?:backend|server|runtime|app|application|service)\b/, /\b(?:in|to|with|using) node\b/, /\bjavascript\b/, /\btypescript\b/, /\bdeno\b/, /\bbun\b/, /\bjs\b/, /\bts\b/],
    fences: ['js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript', 'jsx', 'tsx', 'node'] },
  { id: 'python', label: 'Python', group: 'language', patterns: [/\bpython\d?\b/, /\bpy\b/], fences: ['python', 'py', 'python3'] },
  { id: 'java', label: 'Java', group: 'language', patterns: [/\bjava\b(?!\s*script)/], fences: ['java'] },
  { id: 'kotlin', label: 'Kotlin', group: 'language', patterns: [/\bkotlin\b/], fences: ['kotlin', 'kt'] },
  { id: 'go', label: 'Go', group: 'language', patterns: [/\bgolang\b/, /\b(?:in|to|with|using|into) Go\b/], caseSensitive: true, fences: ['go', 'golang'] },
  { id: 'rust', label: 'Rust', group: 'language', patterns: [/\brust\b/], fences: ['rust', 'rs'] },
  { id: 'ruby', label: 'Ruby', group: 'language', patterns: [/\bruby\b/], fences: ['ruby', 'rb'] },
  { id: 'php', label: 'PHP', group: 'language', patterns: [/\bphp\b/], fences: ['php'] },
  { id: 'csharp', label: 'C# / .NET', group: 'language', patterns: [/(?:^|[^\w])c#/, /\.net\b/, /\bdotnet\b/, /\bcsharp\b/], fences: ['cs', 'csharp', 'c#'] },
  { id: 'cpp', label: 'C++', group: 'language', patterns: [/\bc\+\+/, /\bcpp\b/], fences: ['cpp', 'c++', 'cxx'] },
  { id: 'elixir', label: 'Elixir', group: 'language', patterns: [/\belixir\b/], fences: ['elixir', 'ex', 'exs'] },
  { id: 'scala', label: 'Scala', group: 'language', patterns: [/\bscala\b/], fences: ['scala'] },
  { id: 'swift', label: 'Swift', group: 'language', patterns: [/\bswift\b/], fences: ['swift'] },

  // --- Backend frameworks -------------------------------------------------------
  { id: 'express', label: 'Express', group: 'framework', implies: 'javascript', patterns: [/\bexpress(?:\.?js)?\b/] },
  { id: 'fastify', label: 'Fastify', group: 'framework', implies: 'javascript', patterns: [/\bfastify\b/] },
  { id: 'koa', label: 'Koa', group: 'framework', implies: 'javascript', patterns: [/\bkoa\b/] },
  { id: 'nestjs', label: 'NestJS', group: 'framework', implies: 'javascript', patterns: [/\bnest\.?js\b/] },
  { id: 'hapi', label: 'hapi', group: 'framework', implies: 'javascript', patterns: [/\bhapi\b/] },
  { id: 'django', label: 'Django', group: 'framework', implies: 'python', patterns: [/\bdjango\b/] },
  { id: 'flask', label: 'Flask', group: 'framework', implies: 'python', patterns: [/\bflask\b/] },
  { id: 'fastapi', label: 'FastAPI', group: 'framework', implies: 'python', patterns: [/\bfastapi\b/] },
  { id: 'spring', label: 'Spring', group: 'framework', implies: 'java', patterns: [/\bspring[- ]?(?:boot|framework|mvc)\b/] },
  { id: 'rails', label: 'Ruby on Rails', group: 'framework', implies: 'ruby', patterns: [/\brails\b/] },
  { id: 'laravel', label: 'Laravel', group: 'framework', implies: 'php', patterns: [/\blaravel\b/] },
  { id: 'symfony', label: 'Symfony', group: 'framework', implies: 'php', patterns: [/\bsymfony\b/] },
  { id: 'aspnet', label: 'ASP.NET', group: 'framework', implies: 'csharp', patterns: [/\basp\.net\b/] },
  { id: 'gin', label: 'Gin', group: 'framework', implies: 'go', patterns: [/\bgin\b/] },
  { id: 'phoenix', label: 'Phoenix', group: 'framework', implies: 'elixir', patterns: [/\bphoenix\b/] },

  // --- Databases ------------------------------------------------------------------
  { id: 'postgresql', label: 'PostgreSQL', group: 'database', patterns: [/\bpostgres(?:ql)?\b/] },
  { id: 'mysql', label: 'MySQL', group: 'database', patterns: [/\bmysql\b/, /\bmariadb\b/] },
  { id: 'sqlite', label: 'SQLite', group: 'database', patterns: [/\bsqlite3?\b/] },
  { id: 'mongodb', label: 'MongoDB', group: 'database', patterns: [/\bmongo(?:db)?\b/] },
  { id: 'jsonfiles', label: 'JSON files', group: 'database', patterns: [/\bjson[- ]files?\b/, /\bjson storage\b/] },
  { id: 'mssql', label: 'SQL Server', group: 'database', patterns: [/\bsql server\b/, /\bmssql\b/] },
  { id: 'oracle', label: 'Oracle Database', group: 'database', patterns: [/\boracle\b/] },
  { id: 'dynamodb', label: 'DynamoDB', group: 'database', patterns: [/\bdynamo(?:db)?\b/] },
  { id: 'cassandra', label: 'Cassandra', group: 'database', patterns: [/\bcassandra\b/] },

  // --- Caches ---------------------------------------------------------------------
  { id: 'redis', label: 'Redis', group: 'cache', patterns: [/\bredis\b/] },
  { id: 'memcached', label: 'Memcached', group: 'cache', patterns: [/\bmemcached?\b/] },

  // --- Frontend -------------------------------------------------------------------
  { id: 'vanilla', label: 'plain HTML/CSS/JavaScript', group: 'frontend', patterns: [/\bvanilla\b/, /\bplain (?:html|javascript|js)\b/] },
  { id: 'react', label: 'React', group: 'frontend', patterns: [/\breact(?:\.?js)?\b/, /\bnext\.?js\b/] },
  { id: 'vue', label: 'Vue', group: 'frontend', patterns: [/\bvue(?:\.?js)?\b/, /\bnuxt\b/] },
  { id: 'angular', label: 'Angular', group: 'frontend', patterns: [/\bangular(?:js)?\b/] },
  { id: 'svelte', label: 'Svelte', group: 'frontend', patterns: [/\bsvelte(?:kit)?\b/] },
  { id: 'jquery', label: 'jQuery', group: 'frontend', patterns: [/\bjquery\b/] },

  // --- Architecture styles ------------------------------------------------------------
  { id: 'monolith', label: 'monolith', group: 'architecture', patterns: [/\bmonolith(?:ic|s)?\b/] },
  { id: 'microservices', label: 'microservices', group: 'architecture', patterns: [/\bmicro-?services?\b/] },
  { id: 'serverless', label: 'serverless functions', group: 'architecture', patterns: [/\bserverless\b/, /\blambda functions?\b/] },

  // --- API styles ---------------------------------------------------------------------
  { id: 'rest', label: 'REST', group: 'api', patterns: [/\brestful\b/, /\brest\s*(?:api|apis|endpoints?|interface|service|services)\b/, /\bjson api\b/] },
  { id: 'graphql', label: 'GraphQL', group: 'api', patterns: [/\bgraphql\b/] },
  { id: 'grpc', label: 'gRPC', group: 'api', patterns: [/\bgrpc\b/] },
]);

export const TECH_BY_ID = new Map(TECHNOLOGIES.map((t) => [t.id, t]));

/**
 * Every technology mention in `text`.
 * @returns {Array<{tech: object, index: number, match: string}>} In text order.
 */
export function findTechMentions(text) {
  const source = String(text ?? '');
  const lower = source.toLowerCase();
  const mentions = [];
  for (const tech of TECHNOLOGIES) {
    for (const pattern of tech.patterns) {
      const re = new RegExp(pattern.source, 'g');
      const haystack = tech.caseSensitive ? source : lower;
      for (const m of haystack.matchAll(re)) {
        mentions.push({ tech, index: m.index, match: source.slice(m.index, m.index + m[0].length) });
      }
    }
  }
  return mentions.sort((a, b) => a.index - b.index);
}

/** The technology a code-fence language tag reveals, or null. */
export function techForFence(lang) {
  const tag = String(lang ?? '').toLowerCase();
  return TECHNOLOGIES.find((t) => t.fences?.includes(tag)) ?? null;
}
