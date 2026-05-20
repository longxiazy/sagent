export function ScreenshotImages({ urls }) {
  if (!urls.length) return null;
  return (
    <div className="chat-screenshots">
      {urls.map((url, i) => (
        <img key={i} className="chat-screenshot-img" src={url} alt={`screenshot-${i}`} />
      ))}
    </div>
  );
}
