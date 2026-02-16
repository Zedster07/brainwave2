/**
 * Document Text Extractor — Reads text from binary document formats
 *
 * Supports:
 *   - PDF  → pdf-parse
 *   - DOCX → mammoth
 *   - XLSX → exceljs (converts to readable text table)
 *
 * Used by the file_read tool to transparently extract text from documents.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

// ─── Supported Extensions ───

const BINARY_DOC_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls'])

/** Check if a file path is a supported binary document format */
export function isBinaryDocument(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return BINARY_DOC_EXTENSIONS.has(ext)
}

/** Get the document type from extension */
export function getDocumentType(filePath: string): 'pdf' | 'docx' | 'xlsx' | null {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.pdf': return 'pdf'
    case '.docx': return 'docx'
    case '.xlsx':
    case '.xls': return 'xlsx'
    default: return null
  }
}

// ─── PDF Extraction ───

async function extractPDF(filePath: string): Promise<string> {
  // pdf-parse uses a default import
  const pdfParse = (await import('pdf-parse')).default
  const buffer = await readFile(filePath)
  const data = await pdfParse(buffer)

  const meta: string[] = []
  if (data.info?.Title) meta.push(`Title: ${data.info.Title}`)
  if (data.info?.Author) meta.push(`Author: ${data.info.Author}`)
  if (data.numpages) meta.push(`Pages: ${data.numpages}`)

  const header = meta.length > 0 ? `[PDF Document — ${meta.join(' | ')}]\n\n` : '[PDF Document]\n\n'
  return header + (data.text || '(No text content extracted)')
}

// ─── DOCX Extraction ───

async function extractDOCX(filePath: string): Promise<string> {
  const mammoth = await import('mammoth')
  const buffer = await readFile(filePath)
  const result = await mammoth.extractRawText({ buffer })

  // mammoth gives us messages for any conversion issues
  const warnings = result.messages
    .filter((m) => m.type === 'warning')
    .map((m) => m.message)

  let content = result.value || '(No text content extracted)'

  if (warnings.length > 0) {
    content += `\n\n[Extraction warnings: ${warnings.join('; ')}]`
  }

  return `[DOCX Document]\n\n${content}`
}

// ─── XLSX Extraction ───

async function extractXLSX(filePath: string): Promise<string> {
  const ExcelJSModule = await import('exceljs')
  const ExcelJS = (ExcelJSModule as any).default ?? ExcelJSModule
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const sheets: string[] = []

  workbook.eachSheet((worksheet) => {
    const lines: string[] = []
    lines.push(`## Sheet: ${worksheet.name}`)
    lines.push('')

    // Get all rows as text
    let rowCount = 0
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowCount > 5000) return // Safety cap
      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        const val = cell.value
        if (val === null || val === undefined) {
          cells.push('')
        } else if (typeof val === 'object' && 'result' in val) {
          // Formula cell — show result
          cells.push(String(val.result ?? ''))
        } else if (val instanceof Date) {
          cells.push(val.toISOString().split('T')[0])
        } else {
          cells.push(String(val))
        }
      })
      // Use tab-separated for readability
      if (rowNumber === 1) {
        lines.push(`| ${cells.join(' | ')} |`)
        lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
      } else {
        lines.push(`| ${cells.join(' | ')} |`)
      }
      rowCount++
    })

    if (rowCount === 0) {
      lines.push('(Empty sheet)')
    } else {
      lines.push('')
      lines.push(`[${rowCount} rows]`)
    }

    sheets.push(lines.join('\n'))
  })

  if (sheets.length === 0) {
    return '[XLSX Document]\n\n(No sheets found)'
  }

  return `[XLSX Document — ${sheets.length} sheet(s)]\n\n${sheets.join('\n\n')}`
}

// ─── Public API ───

/**
 * Extract text content from a binary document file.
 * Returns formatted text representation of the document.
 * Throws if the file format is not supported.
 */
export async function extractDocumentText(filePath: string): Promise<string> {
  const docType = getDocumentType(filePath)

  switch (docType) {
    case 'pdf': return extractPDF(filePath)
    case 'docx': return extractDOCX(filePath)
    case 'xlsx': return extractXLSX(filePath)
    default:
      throw new Error(`Unsupported document format: ${extname(filePath)}`)
  }
}
