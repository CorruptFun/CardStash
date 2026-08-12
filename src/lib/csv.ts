/** RFC-4180-ish CSV parser: quotes, escaped quotes, CRLF, no header logic. */
export function parseCsv(text: string): string[][] {
  const src = stripBom(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length))
}

export function csvField(value: unknown): string {
  const str = value == null ? '' : String(value)
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

export function downloadFile(name: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(stripBom(String(reader.result)))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
