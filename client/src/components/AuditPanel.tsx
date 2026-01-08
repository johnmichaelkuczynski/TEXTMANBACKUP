import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  X, 
  Download, 
  Copy, 
  Pause, 
  Play, 
  ChevronDown,
  ChevronRight,
  Database,
  Bot,
  AlertCircle,
  CheckCircle,
  Clock
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface AuditEntry {
  sequenceNum: number;
  timestamp: string;
  eventType: string;
  eventData: any;
}

interface AuditPanelProps {
  auditLogId: number | null;
  isOpen: boolean;
  onClose: () => void;
}

const eventTypeColors: Record<string, string> = {
  db_query: 'bg-green-500/20 text-green-700 dark:text-green-400',
  db_insert: 'bg-green-600/20 text-green-800 dark:text-green-300',
  db_update: 'bg-green-500/20 text-green-700 dark:text-green-400',
  llm_call: 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
  chunk_processed: 'bg-purple-500/20 text-purple-700 dark:text-purple-400',
  skeleton_extracted: 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-400',
  stitch_pass: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  error: 'bg-red-500/20 text-red-700 dark:text-red-400',
  job_started: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  job_completed: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400'
};

const eventTypeIcons: Record<string, any> = {
  db_query: Database,
  db_insert: Database,
  db_update: Database,
  llm_call: Bot,
  chunk_processed: CheckCircle,
  skeleton_extracted: CheckCircle,
  stitch_pass: CheckCircle,
  error: AlertCircle,
  job_started: Clock,
  job_completed: CheckCircle
};

function AuditEntryRow({ entry, isExpanded, onToggle }: { 
  entry: AuditEntry; 
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const Icon = eventTypeIcons[entry.eventType] || Clock;
  const colorClass = eventTypeColors[entry.eventType] || 'bg-gray-500/20 text-gray-700';
  const timestamp = new Date(entry.timestamp).toLocaleTimeString();

  const getSummary = () => {
    const data = entry.eventData;
    switch (entry.eventType) {
      case 'db_query':
        return `${data.operation} ${data.table} (${data.rowsReturned || 0} rows, ${data.durationMs}ms)`;
      case 'db_insert':
        return `INSERT ${data.table} (id: ${data.rowId}, ${data.durationMs}ms)`;
      case 'db_update':
        return `UPDATE ${data.table} (id: ${data.rowId}, ${data.fieldsUpdated?.join(', ')})`;
      case 'llm_call':
        return `${data.model} - ${data.purpose} (${data.inputTokens}/${data.outputTokens} tokens, ${data.durationMs}ms)`;
      case 'chunk_processed':
        return `Chunk ${data.chunkIndex}: ${data.outputWords}/${data.targetWords} words ${data.withinTolerance ? '(OK)' : '(FLAGGED)'}`;
      case 'skeleton_extracted':
        return `${data.claimsCount} claims, ${data.termsCount} terms, target: ${data.totalTargetWords} words`;
      case 'stitch_pass':
        return `Score: ${data.coherenceScore}, ${data.claimsCovered}/${data.claimsCovered + data.claimsMissing} claims covered`;
      case 'error':
        return `${data.errorType}: ${data.message.substring(0, 50)}...`;
      case 'job_started':
        return `Started ${data.jobType}${data.targetWords ? ` (target: ${data.targetWords} words)` : ''}`;
      case 'job_completed':
        return `${data.success ? 'Completed' : 'Failed'} ${data.jobType}${data.actualWords ? ` (${data.actualWords} words)` : ''}`;
      default:
        return JSON.stringify(data).substring(0, 50);
    }
  };

  return (
    <div className="border-b border-border/50 last:border-0">
      <div 
        className="flex items-center gap-2 p-2 cursor-pointer hover-elevate"
        onClick={onToggle}
        data-testid={`audit-entry-${entry.sequenceNum}`}
      >
        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Badge variant="outline" className={`text-xs ${colorClass}`}>
          <Icon className="w-3 h-3 mr-1" />
          {entry.eventType}
        </Badge>
        <span className="text-xs text-muted-foreground">{timestamp}</span>
        <span className="text-xs flex-1 truncate">{getSummary()}</span>
      </div>
      {isExpanded && (
        <div className="p-3 bg-muted/30 text-xs font-mono overflow-x-auto">
          <pre>{JSON.stringify(entry.eventData, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export function AuditPanel({ auditLogId, isOpen, onClose }: AuditPanelProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const [isCompleted, setIsCompleted] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const connectWebSocket = useCallback(() => {
    if (!auditLogId || wsRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/audit`);
    
    ws.onopen = () => {
      setWsConnected(true);
      ws.send(JSON.stringify({ type: 'subscribe', auditLogId }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      if (message.type === 'entry' && !isPaused) {
        setEntries(prev => [...prev, message.entry]);
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }
      
      if (message.type === 'history') {
        setEntries(message.entries);
      }
      
      if (message.type === 'completed') {
        setIsCompleted(true);
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
    };

    wsRef.current = ws;
  }, [auditLogId, isPaused]);

  useEffect(() => {
    if (isOpen && auditLogId) {
      connectWebSocket();
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [isOpen, auditLogId, connectWebSocket]);

  const handleCopyAll = async () => {
    const text = entries.map(e => 
      `[${new Date(e.timestamp).toISOString()}] ${e.eventType}: ${JSON.stringify(e.eventData)}`
    ).join('\n');
    
    await navigator.clipboard.writeText(text);
    toast({ title: 'Copied', description: 'Audit log copied to clipboard' });
  };

  const handleDownloadJSON = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_${auditLogId}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadTXT = () => {
    const text = entries.map(e => 
      `[${new Date(e.timestamp).toISOString()}] ${e.eventType}\n${JSON.stringify(e.eventData, null, 2)}\n`
    ).join('\n---\n');
    
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_${auditLogId}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleEntry = (sequenceNum: number) => {
    setExpandedEntries(prev => {
      const next = new Set(prev);
      if (next.has(sequenceNum)) {
        next.delete(sequenceNum);
      } else {
        next.add(sequenceNum);
      }
      return next;
    });
  };

  const summary = {
    total: entries.length,
    dbOps: entries.filter(e => e.eventType.startsWith('db_')).length,
    llmCalls: entries.filter(e => e.eventType === 'llm_call').length,
    chunks: entries.filter(e => e.eventType === 'chunk_processed').length,
    errors: entries.filter(e => e.eventType === 'error').length
  };

  if (!isOpen) return null;

  return (
    <Card className="fixed right-4 top-20 bottom-4 w-[480px] z-50 flex flex-col shadow-lg" data-testid="audit-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 py-3 px-4 border-b">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">Audit Log</CardTitle>
          {wsConnected && !isCompleted && (
            <Badge variant="outline" className="bg-green-500/20 text-green-700 text-xs">LIVE</Badge>
          )}
          {isCompleted && (
            <Badge variant="outline" className="bg-blue-500/20 text-blue-700 text-xs">COMPLETE</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button 
            size="icon" 
            variant="ghost" 
            onClick={() => setIsPaused(!isPaused)}
            data-testid="button-pause-audit"
          >
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </Button>
          <Button 
            size="icon" 
            variant="ghost" 
            onClick={handleCopyAll}
            data-testid="button-copy-audit"
          >
            <Copy className="w-4 h-4" />
          </Button>
          <Button 
            size="icon" 
            variant="ghost" 
            onClick={handleDownloadJSON}
            data-testid="button-download-json"
          >
            <Download className="w-4 h-4" />
          </Button>
          <Button 
            size="icon" 
            variant="ghost" 
            onClick={onClose}
            data-testid="button-close-audit"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>

      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 text-xs">
        <span>Events: {summary.total}</span>
        <span className="text-green-600">DB: {summary.dbOps}</span>
        <span className="text-blue-600">LLM: {summary.llmCalls}</span>
        <span className="text-purple-600">Chunks: {summary.chunks}</span>
        {summary.errors > 0 && <span className="text-red-600">Errors: {summary.errors}</span>}
      </div>

      <CardContent className="flex-1 p-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="divide-y divide-border/50">
            {entries.map(entry => (
              <AuditEntryRow
                key={entry.sequenceNum}
                entry={entry}
                isExpanded={expandedEntries.has(entry.sequenceNum)}
                onToggle={() => toggleEntry(entry.sequenceNum)}
              />
            ))}
            {entries.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                Waiting for events...
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <div className="p-2 border-t flex gap-2">
        <Button size="sm" variant="outline" onClick={handleDownloadTXT} className="flex-1" data-testid="button-download-txt">
          Download TXT
        </Button>
        <Button size="sm" variant="outline" onClick={handleDownloadJSON} className="flex-1" data-testid="button-download-json-full">
          Download JSON
        </Button>
      </div>
    </Card>
  );
}
