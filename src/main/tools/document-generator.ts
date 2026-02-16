/**
 * Document Generator — Creates PDF, DOCX, XLSX, and PPTX documents
 *
 * Provides structured document generation from agent-provided content:
 *   - PDF  → pdfkit
 *   - DOCX → docx (officegen)
 *   - XLSX → exceljs
 *   - PPTX → pptxgenjs
 *
 * Used by the generate_pdf, generate_docx, generate_xlsx, generate_pptx tools.
 */
import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname } from 'node:path'

// ─── Shared Types ───

export interface DocSection {
  heading?: string
  body?: string
  bullets?: string[]
}

export interface DocTable {
  headers: string[]
  rows: string[][]
}

export interface SheetData {
  name: string
  headers: string[]
  rows: (string | number | boolean | null)[][]
}

export interface SlideData {
  title?: string
  body?: string
  bullets?: string[]
  notes?: string
  table?: DocTable
}

// ─── PDF Generation ───

export async function generatePDF(
  outputPath: string,
  options: {
    title?: string
    author?: string
    sections?: DocSection[]
    tables?: DocTable[]
  }
): Promise<{ path: string; pageCount: number }> {
  const PDFDocument = (await import('pdfkit')).default
  await mkdir(dirname(outputPath), { recursive: true })

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      info: {
        Title: options.title || 'Generated Document',
        Author: options.author || 'Brainwave',
      },
    })

    const stream = createWriteStream(outputPath)
    doc.pipe(stream)

    // Title
    if (options.title) {
      doc.fontSize(24).font('Helvetica-Bold').text(options.title, { align: 'center' })
      doc.moveDown(1.5)
    }

    // Sections
    if (options.sections) {
      for (const section of options.sections) {
        if (section.heading) {
          doc.fontSize(16).font('Helvetica-Bold').text(section.heading)
          doc.moveDown(0.5)
        }
        if (section.body) {
          doc.fontSize(11).font('Helvetica').text(section.body, { align: 'left', lineGap: 3 })
          doc.moveDown(0.8)
        }
        if (section.bullets && section.bullets.length > 0) {
          doc.fontSize(11).font('Helvetica')
          for (const bullet of section.bullets) {
            doc.text(`  •  ${bullet}`, { indent: 20, lineGap: 2 })
          }
          doc.moveDown(0.8)
        }
      }
    }

    // Tables
    if (options.tables) {
      for (const table of options.tables) {
        const colCount = table.headers.length
        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
        const colWidth = pageWidth / colCount

        // Header row
        doc.fontSize(10).font('Helvetica-Bold')
        const headerY = doc.y
        table.headers.forEach((header, i) => {
          doc.text(header, doc.page.margins.left + i * colWidth, headerY, {
            width: colWidth,
            align: 'left',
          })
        })
        doc.moveTo(doc.page.margins.left, doc.y + 2)
          .lineTo(doc.page.margins.left + pageWidth, doc.y + 2)
          .stroke()
        doc.moveDown(0.3)

        // Data rows
        doc.fontSize(10).font('Helvetica')
        for (const row of table.rows) {
          const rowY = doc.y
          // Check for page break
          if (rowY > doc.page.height - doc.page.margins.bottom - 30) {
            doc.addPage()
          }
          const currentY = doc.y
          row.forEach((cell, i) => {
            doc.text(String(cell ?? ''), doc.page.margins.left + i * colWidth, currentY, {
              width: colWidth,
              align: 'left',
            })
          })
          doc.moveDown(0.3)
        }
        doc.moveDown(1)
      }
    }

    // Track page count
    let pageCount = 0
    doc.on('pageAdded', () => { pageCount++ })

    doc.end()

    stream.on('finish', () => {
      // pageCount starts at 0 for added pages, but first page is always 1
      resolve({ path: outputPath, pageCount: pageCount + 1 })
    })
    stream.on('error', reject)
  })
}

// ─── DOCX Generation ───

export async function generateDOCX(
  outputPath: string,
  options: {
    title?: string
    author?: string
    sections?: DocSection[]
    tables?: DocTable[]
  }
): Promise<{ path: string }> {
  const docx = await import('docx')
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = docx

  await mkdir(dirname(outputPath), { recursive: true })

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []

  // Title
  if (options.title) {
    children.push(
      new Paragraph({
        text: options.title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
      })
    )
  }

  // Sections
  if (options.sections) {
    for (const section of options.sections) {
      if (section.heading) {
        children.push(
          new Paragraph({
            text: section.heading,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120 },
          })
        )
      }
      if (section.body) {
        // Split by newlines to create separate paragraphs
        const paragraphs = section.body.split('\n').filter((l) => l.trim())
        for (const text of paragraphs) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text, size: 22 })],
              spacing: { after: 120 },
            })
          )
        }
      }
      if (section.bullets && section.bullets.length > 0) {
        for (const bullet of section.bullets) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: bullet, size: 22 })],
              bullet: { level: 0 },
              spacing: { after: 60 },
            })
          )
        }
      }
    }
  }

  // Tables
  if (options.tables) {
    for (const table of options.tables) {
      const headerRow = new TableRow({
        children: table.headers.map(
          (header) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: header, bold: true, size: 20 })] })],
              shading: { fill: 'E8E8E8' },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1 },
                bottom: { style: BorderStyle.SINGLE, size: 1 },
                left: { style: BorderStyle.SINGLE, size: 1 },
                right: { style: BorderStyle.SINGLE, size: 1 },
              },
            })
        ),
        tableHeader: true,
      })

      const dataRows = table.rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: String(cell ?? ''), size: 20 })] })],
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 1 },
                    bottom: { style: BorderStyle.SINGLE, size: 1 },
                    left: { style: BorderStyle.SINGLE, size: 1 },
                    right: { style: BorderStyle.SINGLE, size: 1 },
                  },
                })
            ),
          })
      )

      children.push(
        new Table({
          rows: [headerRow, ...dataRows],
          width: { size: 100, type: WidthType.PERCENTAGE },
        })
      )
      // Spacing after table
      children.push(new Paragraph({ text: '', spacing: { after: 240 } }))
    }
  }

  const document = new Document({
    creator: options.author || 'Brainwave',
    title: options.title,
    sections: [{ children }],
  })

  const buffer = await Packer.toBuffer(document)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(outputPath, buffer)

  return { path: outputPath }
}

// ─── XLSX Generation ───

export async function generateXLSX(
  outputPath: string,
  options: {
    sheets: SheetData[]
    author?: string
  }
): Promise<{ path: string; sheetCount: number }> {
  const ExcelJSModule = await import('exceljs')
  // Handle ESM/CJS interop — exceljs may export Workbook on .default or directly
  const ExcelJS = (ExcelJSModule as any).default ?? ExcelJSModule
  const workbook = new ExcelJS.Workbook()
  workbook.creator = options.author || 'Brainwave'
  workbook.created = new Date()

  await mkdir(dirname(outputPath), { recursive: true })

  for (const sheet of options.sheets) {
    // Accept both "name" and "title" as the sheet name (LLMs sometimes use "title")
    const sheetName = sheet.name || (sheet as any).title || 'Sheet1'
    const ws = workbook.addWorksheet(sheetName)

    // Header row
    if (sheet.headers && sheet.headers.length > 0) {
      ws.addRow(sheet.headers)
      // Bold + light background for header
      const headerRow = ws.getRow(1)
      headerRow.font = { bold: true }
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE8E8E8' },
      }
      headerRow.commit()
    }

    // Data rows — accept both "rows" and "data" keys (LLMs sometimes use "data")
    const rows = sheet.rows ?? (sheet as any).data ?? []
    for (const row of rows) {
      ws.addRow(row)
    }

    // Auto-fit column widths (approximate)
    ws.columns.forEach((column) => {
      let maxLength = 10
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = String(cell.value ?? '').length
        if (len > maxLength) maxLength = len
      })
      column.width = Math.min(maxLength + 2, 50)
    })
  }

  await workbook.xlsx.writeFile(outputPath)

  return { path: outputPath, sheetCount: options.sheets.length }
}

// ─── PPTX Generation ───

export async function generatePPTX(
  outputPath: string,
  options: {
    slides: SlideData[]
    title?: string
    author?: string
    subject?: string
  }
): Promise<{ path: string; slideCount: number }> {
  const PptxGenJS = (await import('pptxgenjs')).default
  const pptx = new PptxGenJS()

  await mkdir(dirname(outputPath), { recursive: true })

  // Metadata
  if (options.title) pptx.title = options.title
  if (options.author) pptx.author = options.author
  if (options.subject) pptx.subject = options.subject
  pptx.company = 'Brainwave'

  // If no slides provided, create a blank title slide
  if (!options.slides || options.slides.length === 0) {
    const slide = pptx.addSlide()
    slide.addText(options.title || 'Untitled Presentation', {
      x: 0.5, y: 1.5, w: 9, h: 1.5,
      fontSize: 32, bold: true, align: 'center', color: '333333',
    })
    return { path: outputPath, slideCount: 1 }
  }

  for (const slideData of options.slides) {
    const slide = pptx.addSlide()
    let yOffset = 0.5

    // Slide title
    if (slideData.title) {
      slide.addText(slideData.title, {
        x: 0.5, y: yOffset, w: 9, h: 0.8,
        fontSize: 24, bold: true, color: '333333',
      })
      yOffset += 1.0
    }

    // Body text
    if (slideData.body) {
      slide.addText(slideData.body, {
        x: 0.5, y: yOffset, w: 9, h: 1.5,
        fontSize: 14, color: '555555', valign: 'top',
      })
      yOffset += 1.7
    }

    // Bullet points
    if (slideData.bullets && slideData.bullets.length > 0) {
      const bulletText = slideData.bullets.map((b) => ({
        text: b,
        options: { bullet: true as const, fontSize: 14, color: '444444' },
      }))
      slide.addText(bulletText, {
        x: 0.5, y: yOffset, w: 9,
        h: Math.min(slideData.bullets.length * 0.45 + 0.3, 3.5),
        valign: 'top',
      })
      yOffset += Math.min(slideData.bullets.length * 0.45 + 0.5, 3.7)
    }

    // Table
    if (slideData.table && slideData.table.headers.length > 0) {
      const tableRows: Array<Array<{ text: string; options?: Record<string, unknown> }>> = []
      // Header row
      tableRows.push(
        slideData.table.headers.map((h) => ({
          text: h,
          options: { bold: true, fill: { color: 'E8E8E8' }, fontSize: 11 },
        }))
      )
      // Data rows
      for (const row of slideData.table.rows) {
        tableRows.push(row.map((cell) => ({ text: String(cell ?? ''), options: { fontSize: 10 } })))
      }

      slide.addTable(tableRows, {
        x: 0.5, y: yOffset, w: 9,
        border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
        colW: Array(slideData.table.headers.length).fill(9 / slideData.table.headers.length),
      })
    }

    // Speaker notes
    if (slideData.notes) {
      slide.addNotes(slideData.notes)
    }
  }

  await pptx.writeFile({ fileName: outputPath })

  return { path: outputPath, slideCount: options.slides.length }
}
