import { DotsThreeIcon, GearIcon, PencilSimpleIcon, PlugIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { McpServerRecord } from "@sketch/shared";
/**
 * MCP Servers section: admin CRUD for workspace-level MCP servers.
 */
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";

export function McpServersSection({
  servers,
  isAdmin = true,
  onAdd,
  onEdit,
  onRemove,
  onTestConnection,
}: {
  servers: McpServerRecord[];
  isAdmin?: boolean;
  onAdd: () => void;
  onEdit: (server: McpServerRecord) => void;
  onRemove: (server: McpServerRecord) => void;
  onTestConnection: (server: McpServerRecord) => void;
}) {
  return (
    <div>
      {servers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-[#FEED01]/[0.04] px-6 pt-8 pb-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-white border border-[#FEED01]">
            <GearIcon size={24} className="text-[#8B7A00]" />
          </div>
          <p className="mt-3 text-sm font-medium">
            {isAdmin ? "No MCP servers configured" : "No servers available yet"}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isAdmin ? (
              <>
                Connect a custom MCP server to give
                <br />
                the agent access to your internal tools.
              </>
            ) : (
              "Your admin hasn't configured any MCP servers."
            )}
          </p>
          {isAdmin && (
            <Button variant="ghost" size="sm" className="mt-4 gap-1.5 hover:bg-[#FEED01]/8" onClick={onAdd}>
              <PlusIcon size={14} weight="bold" />
              New server
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="mb-5 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {isAdmin ? `${servers.length} ${servers.length === 1 ? "server" : "servers"}` : "Available servers"}
            </span>
            {isAdmin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onAdd}
                className="h-7 gap-1.5 rounded-md px-2.5 text-xs hover:bg-[#FEED01]/8"
              >
                <PlusIcon size={12} weight="bold" />
                New server
              </Button>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {servers.map((server, i) => (
              <McpServerRow
                key={server.id}
                server={server}
                isLast={i === servers.length - 1}
                isAdmin={isAdmin}
                onEdit={() => onEdit(server)}
                onRemove={() => onRemove(server)}
                onTestConnection={() => onTestConnection(server)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function McpServerRow({
  server,
  isLast,
  isAdmin = true,
  onEdit,
  onRemove,
  onTestConnection,
}: {
  server: McpServerRecord;
  isLast: boolean;
  isAdmin?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onTestConnection: () => void;
}) {
  return (
    <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
      <div className="flex size-7 items-center justify-center rounded-full bg-muted">
        <GearIcon size={14} className="text-muted-foreground" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{server.displayName}</span>
          {server.type && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#FEED01]/10 px-2 py-0.5 text-[10px] text-muted-foreground">
              <span className="inline-block size-1 rounded-full bg-[#FEED01]" />
              {server.type}
            </span>
          )}
        </div>
        <span className="truncate text-xs font-mono text-muted-foreground">{server.url}</span>
      </div>

      {isAdmin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <DotsThreeIcon size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <PencilSimpleIcon size={14} className="mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onTestConnection}>
              <PlugIcon size={14} className="mr-2" />
              Test connection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={onRemove}>
              <TrashIcon size={14} className="mr-2" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
