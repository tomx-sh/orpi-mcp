import { Badge } from "@/components/ui/badge";
import { toolCatalog } from "@/lib/tool-catalog";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const tools = Object.entries(toolCatalog).map(([name, description]) => ({ name, description }));

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle><h1>ORPI MCP</h1></CardTitle>
          <CardDescription>
            A personal connection to Neotimm for Codex and Hermes Agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">Read-only</Badge>
            <Badge variant="outline">Streamable HTTP</Badge>
            <Badge variant="outline">Bearer authentication</Badge>
          </div>
          <p>
            MCP endpoint: <code>/api/mcp</code>
          </p>
        </CardContent>
        <CardFooter>
          <p className="text-sm text-muted-foreground">
            Add this site&apos;s URL followed by /api/mcp to your MCP client,
            then provide your MCP access token. Account data requires authentication.
          </p>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><h2>Available tools</h2></CardTitle>
          <CardDescription>Start with list_accounts, then select an account and role.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Tool</TableHead>
                <TableHead scope="col">Purpose</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell><code>{tool.name}</code></TableCell>
                  <TableCell className="whitespace-normal">{tool.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
