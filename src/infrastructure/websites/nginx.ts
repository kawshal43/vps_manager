import { websiteDomain } from '../../domain/websites/types'

interface Directive {
  name: string
  args: string[]
  children?: Directive[]
}
export interface NginxSite {
  domains: string[]
  root?: string
  upstream?: string
  https: boolean
  certificatePath?: string
  configPath: string
}
export function parseNginx(text: string, configPath: string): NginxSite[] {
  const tokens: string[] = []
  let word = '',
    quote = '',
    comment = false,
    escaped = false
  const flush = () => {
    if (word) {
      tokens.push(word)
      word = ''
    }
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (comment) {
      if (ch === '\n') comment = false
      continue
    }
    if (escaped) {
      word += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#') {
      flush()
      comment = true
      continue
    }
    if (ch === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2)
      if (end < 0) return []
      word += text.slice(i, end + 1)
      i = end
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    if ('{};'.includes(ch)) {
      flush()
      tokens.push(ch)
      continue
    }
    word += ch
  }
  flush()
  if (quote || escaped || tokens.length > 100000) return []
  let cursor = 0
  const parse = (depth = 0): Directive[] => {
    if (depth > 40) throw new Error('Nginx nesting limit')
    const result: Directive[] = []
    let closed = false
    while (cursor < tokens.length) {
      if (tokens[cursor] === '}') {
        if (depth === 0) throw new Error('Unexpected closing block')
        closed = true
        cursor++
        break
      }
      const values: string[] = []
      while (cursor < tokens.length && !['{', ';', '}'].includes(tokens[cursor]))
        values.push(tokens[cursor++])
      if (!values.length) throw new Error('Invalid Nginx syntax')
      const next = tokens[cursor++]
      if (next !== '{' && next !== ';') throw new Error('Incomplete Nginx directive')
      result.push({
        name: values[0],
        args: values.slice(1),
        ...(next === '{' ? { children: parse(depth + 1) } : {}),
      })
    }
    if (depth && !closed) throw new Error('Unclosed Nginx block')
    return result
  }
  try {
    const all = parse()
    const sites: NginxSite[] = []
    const walk = (nodes: Directive[]) => {
      for (const node of nodes) {
        if (node.name === 'server' && node.children) {
          const directives = node.children
          const domains = directives
            .filter((d) => d.name === 'server_name')
            .flatMap((d) => d.args)
            .filter((d) => websiteDomain.safeParse(d).success)
          if (!domains.length) continue
          const roots = directives
            .filter((d) => d.name === 'root')
            .map((d) => d.args[0])
            .filter((p) => p?.startsWith('/') && !p.includes('$'))
          const proxies: string[] = []
          const findProxy = (children: Directive[]) =>
            children.forEach((d) => {
              if (d.name === 'proxy_pass') proxies.push(d.args[0])
              if (d.children) findProxy(d.children)
            })
          findProxy(directives)
          sites.push({
            domains: [...new Set(domains)],
            root: new Set(roots).size === 1 ? roots[0] : undefined,
            upstream: new Set(proxies).size === 1 ? proxies[0] : undefined,
            https: directives.some(
              (d) =>
                d.name === 'listen' &&
                (d.args.includes('ssl') || d.args.some((a) => /(?:^|:)443$/.test(a))),
            ),
            certificatePath: directives.find((d) => d.name === 'ssl_certificate')?.args[0],
            configPath,
          })
        } else if (node.children) walk(node.children)
      }
    }
    walk(all)
    return sites
  } catch {
    return []
  }
}
