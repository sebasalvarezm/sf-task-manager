import {
  Home,
  ListChecks,
  Phone,
  FileText,
  Send,
  Building2,
  Search,
  BarChart3,
  FlaskConical,
  MapPin,
  CalendarRange,
  MessageSquare,
  Inbox,
  Mail,
  Workflow,
  PhoneCall,
  ChartLine,
  type LucideIcon,
} from "lucide-react";

/**
 * The app's map, in the order the work happens. Groups are the three big
 * blocks Seb thinks in: the outreach workflow (Tasks → Outreach → Weekly
 * outreach → Sourcing → Send queue, plus the inbound side), calls, and stats.
 * Both the sidebar and the home page render from this one list.
 */
export type NavTool = {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  needs: Array<"sf" | "ms" | "outreach">;
};

export type NavGroup = {
  key: string;
  label: string;
  icon: LucideIcon;
  description: string;
  tools: NavTool[];
};

export const HOME: NavTool = { href: "/", label: "Home", icon: Home, description: "", needs: [] };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "outreach",
    label: "Outreach",
    icon: Workflow,
    description: "From this week's tasks to scheduled emails, in order.",
    tools: [
      { href: "/tasks", label: "Tasks", icon: ListChecks, description: "Open Salesforce tasks by week; send reconnects into Weekly outreach.", needs: ["sf"] },
      { href: "/outreach", label: "Outreach", icon: Send, description: "Accounts due for another touch, prequalified; push E1s to Weekly outreach.", needs: ["sf", "outreach"] },
      { href: "/weekly-outreach", label: "Weekly outreach", icon: CalendarRange, description: "This week's E1 and RCE list; draft reconnects, send E1s to Sourcing.", needs: ["sf", "ms"] },
      { href: "/sourcing", label: "Sourcing", icon: Search, description: "Research each company and write the personalised E1.", needs: [] },
      { href: "/send", label: "Send queue", icon: Mail, description: "Checked E1s: contact, verification, review flags; approve and schedule in Outreach.", needs: ["sf", "outreach"] },
      { href: "/inmail", label: "InMail queue", icon: MessageSquare, description: "End-of-sequence contacts to reach on LinkedIn.", needs: ["sf"] },
      { href: "/inbox", label: "Inbox", icon: Inbox, description: "Replies classified, with a draft answer ready to send.", needs: ["sf", "ms"] },
    ],
  },
  {
    key: "calls",
    label: "Calls",
    icon: PhoneCall,
    description: "Before and after every call.",
    tools: [
      { href: "/prep", label: "Call prep", icon: FileText, description: "A one-pager on the company ahead of the call.", needs: ["sf", "ms"] },
      { href: "/calls", label: "Call logger", icon: Phone, description: "Log the week's meetings and follow-ups to Salesforce.", needs: ["sf", "ms"] },
    ],
  },
  {
    key: "stats",
    label: "Stats",
    icon: ChartLine,
    description: "How the outreach is doing and what works.",
    tools: [
      { href: "/stats", label: "Weekly stats", icon: BarChart3, description: "Outreach, calls, meetings, pipeline and AI spend.", needs: ["sf"] },
      { href: "/replies", label: "What gets replies", icon: FlaskConical, description: "Which senders, sequences and markets get answered.", needs: ["sf", "outreach"] },
    ],
  },
];

export const STANDALONE_TOOLS: NavTool[] = [
  { href: "/accounts", label: "Accounts", icon: Building2, description: "Create a Salesforce account from a company URL.", needs: ["sf"] },
  { href: "/trip", label: "Trip planner", icon: MapPin, description: "Accounts and targets around a trip.", needs: ["sf"] },
];

export function groupForPath(pathname: string): string | null {
  for (const g of NAV_GROUPS) {
    if (g.tools.some((t) => pathname === t.href || pathname.startsWith(t.href + "/"))) return g.key;
  }
  return null;
}
