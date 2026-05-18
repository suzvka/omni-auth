// src/app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "通用账户与平台资源数据中心",
  description: "中心系统 API",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
