import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownMessage({ text }: { text: string }) {
  return <div className="chat-text chat-markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
      img: ({ alt }) => <span>{alt}</span>,
      table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>
}
