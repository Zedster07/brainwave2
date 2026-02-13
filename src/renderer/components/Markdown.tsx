import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  h1: ({ children }) => <h1 className="text-xl font-bold text-white mt-4 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold text-white mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-semibold text-gray-200 mt-2.5 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold text-gray-300 mt-2 mb-1">{children}</h4>,
  p: ({ children }) => <p className="text-sm text-gray-300 leading-relaxed mb-2">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="text-gray-400 italic">{children}</em>,
  ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-sm text-gray-300 leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent/80 underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/40 pl-3 my-2 text-gray-400 italic">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    const isInline = !className
    if (isInline) {
      return <code className="text-[13px] bg-white/[0.06] text-accent/90 rounded px-1.5 py-0.5 font-mono">{children}</code>
    }
    return (
      <pre className="bg-white/[0.04] border border-white/[0.06] rounded-lg p-3 my-2 overflow-x-auto">
        <code className="text-[13px] text-gray-300 font-mono leading-relaxed">{children}</code>
      </pre>
    )
  },
  pre: ({ children }) => <>{children}</>,
  hr: () => <hr className="border-white/[0.08] my-3" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-white/[0.1]">{children}</thead>,
  th: ({ children }) => <th className="text-left text-gray-400 font-medium px-2 py-1.5 text-xs">{children}</th>,
  td: ({ children }) => <td className="text-gray-300 px-2 py-1.5 border-b border-white/[0.04]">{children}</td>,
}

interface MarkdownProps {
  content: string
  className?: string
}

export function Markdown({ content, className = '' }: MarkdownProps) {
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
