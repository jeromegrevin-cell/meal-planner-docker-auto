import { useState } from "react";

export default function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  style = {}
}) {
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: "4px 6px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-elev)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        ...style
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span>
      {hover && label ? (
        <span
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            marginTop: 6,
            padding: "2px 6px",
            fontSize: 11,
            whiteSpace: "nowrap",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            boxShadow: "var(--shadow)",
            zIndex: 10
          }}
        >
          {label}
        </span>
      ) : null}
    </button>
  );
}
