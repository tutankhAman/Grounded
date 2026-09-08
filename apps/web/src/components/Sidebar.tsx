import {
  Database,
  FileText,
  GitCompare,
  Layers,
  LayoutDashboard,
} from "lucide-react";
import type React from "react";
import { NavLink } from "react-router-dom";
import { UploadButton } from "./UploadButton";

interface NavItem {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { icon: LayoutDashboard, label: "Overview", path: "/" },
  { icon: FileText, label: "Documents", path: "/documents" },
  { icon: Database, label: "Facts", path: "/facts" },
  { icon: GitCompare, label: "Relationships", path: "/relationships" },
  { icon: Layers, label: "Entities", path: "/entities" },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      {/* Brand Header */}
      <div
        className="brand-header"
        style={{
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "20px 18px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 10,
          }}
        >
          <span
            style={{
              background: "var(--accent-olive)",
              borderRadius: 6,
              display: "inline-block",
              flexShrink: 0,
              height: 14,
              width: 14,
            }}
          />
          <h1
            className="brand-title"
            style={{
              color: "var(--text-main)",
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              lineHeight: 1.2,
            }}
          >
            Grounded
          </h1>
        </div>
        <p
          className="brand-title"
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.06em",
            paddingLeft: 24,
            textTransform: "uppercase",
          }}
        >
          Knowledge Layer
        </p>
      </div>

      {/* Navigation List */}
      <nav
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 4,
          overflowY: "auto",
          padding: "14px 10px",
        }}
      >
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
          <NavLink className="nav-item" end={path === "/"} key={path} to={path}>
            <Icon size={18} />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Pinned Upload Action */}
      <UploadButton variant="sidebar" />
    </aside>
  );
}
