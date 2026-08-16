import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MessageCircle, Images, Users, Upload, Activity, LogOut, Sparkles } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/chat", label: "Chat", icon: MessageCircle },
  { to: "/replicas", label: "Replicas", icon: Users },
  { to: "/upload", label: "Import", icon: Upload },
  { to: "/memories", label: "Memories", icon: Images },
  { to: "/diagnostics", label: "Diagnostics", icon: Activity },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await auth.signOut();
    navigate({ to: "/", replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/chat" className="flex items-center gap-2 font-display text-lg font-semibold">
            <Sparkles className="size-5 text-primary" aria-hidden />
            Always Together
          </Link>
          <nav className="ml-auto hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  pathname.startsWith(item.to) && "bg-accent text-foreground",
                )}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            ))}
          </nav>
          <Button variant="ghost" size="sm" className="ml-auto md:ml-2" onClick={handleSignOut}>
            <LogOut className="size-4" aria-hidden />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>

      <nav className="sticky bottom-0 z-30 border-t border-border/70 bg-background/95 backdrop-blur md:hidden">
        <div className="flex items-center justify-around px-2 py-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium text-muted-foreground",
                pathname.startsWith(item.to) && "text-primary",
              )}
            >
              <item.icon className="size-5" aria-hidden />
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
