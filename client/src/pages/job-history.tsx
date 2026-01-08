import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  History, 
  Eye,
  Download,
  FileText,
  Clock,
  CheckCircle,
  XCircle,
  Loader2
} from 'lucide-react';
import { AuditPanel } from '@/components/AuditPanel';
import { format } from 'date-fns';

interface AuditLog {
  id: number;
  userId: number;
  jobType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  metadata: any;
}

interface AuditReport {
  log: AuditLog;
  entries: any[];
  summary: {
    totalEvents: number;
    dbOperations: number;
    llmCalls: number;
    chunksProcessed: number;
    errors: number;
    totalTokensUsed: number;
    totalDurationMs: number;
  };
}

const jobTypeLabels: Record<string, string> = {
  reconstruction: 'Conservative Reconstruction',
  expansion: 'Universal Expansion',
  objections: 'Generate Objections',
  bulletproof: 'Objection-Proof Rewrite',
  full_suite: 'Full Suite Pipeline',
  coherence: 'Coherence Meter'
};

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  running: 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
  completed: 'bg-green-500/20 text-green-700 dark:text-green-400',
  failed: 'bg-red-500/20 text-red-700 dark:text-red-400'
};

const statusIcons: Record<string, any> = {
  pending: Clock,
  running: Loader2,
  completed: CheckCircle,
  failed: XCircle
};

export default function JobHistoryPage() {
  const [selectedAuditId, setSelectedAuditId] = useState<number | null>(null);
  const [showAuditPanel, setShowAuditPanel] = useState(false);

  const { data: logsData, isLoading } = useQuery<{ logs: AuditLog[] }>({
    queryKey: ['/api/audit-logs']
  });

  const handleViewAudit = (auditId: number) => {
    setSelectedAuditId(auditId);
    setShowAuditPanel(true);
  };

  const handleDownloadReport = async (auditId: number) => {
    try {
      const res = await fetch(`/api/audit-logs/${auditId}`);
      const { report } = await res.json() as { report: AuditReport };
      
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit_report_${auditId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download report:', error);
    }
  };

  const logs = logsData?.logs || [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <History className="w-5 h-5" />
            <CardTitle>Job History</CardTitle>
          </div>
          <CardDescription>
            View audit logs for all past operations. Each job produces a permanent audit trail showing every database query, LLM call, and processing step.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin mr-2" />
              <span>Loading job history...</span>
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No jobs found. Run an operation to see its audit trail here.</p>
            </div>
          ) : (
            <ScrollArea className="h-[600px]">
              <div className="space-y-3">
                {logs.map((log) => {
                  const StatusIcon = statusIcons[log.status] || Clock;
                  const statusColor = statusColors[log.status] || statusColors.pending;
                  const jobLabel = jobTypeLabels[log.jobType] || log.jobType;
                  
                  return (
                    <Card key={log.id} className="hover-elevate" data-testid={`job-card-${log.id}`}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3 flex-1">
                            <Badge variant="outline" className={statusColor}>
                              <StatusIcon className={`w-3 h-3 mr-1 ${log.status === 'running' ? 'animate-spin' : ''}`} />
                              {log.status}
                            </Badge>
                            <div>
                              <div className="font-medium">{jobLabel}</div>
                              <div className="text-xs text-muted-foreground">
                                {format(new Date(log.startedAt), 'MMM d, yyyy h:mm a')}
                                {log.completedAt && (
                                  <span className="ml-2">
                                    Duration: {Math.round((new Date(log.completedAt).getTime() - new Date(log.startedAt).getTime()) / 1000)}s
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          
                          {log.metadata && (
                            <div className="text-sm text-muted-foreground">
                              {log.metadata.targetWords && (
                                <span className="mr-3">Target: {log.metadata.targetWords.toLocaleString()} words</span>
                              )}
                              {log.metadata.actualWords && (
                                <span>Output: {log.metadata.actualWords.toLocaleString()} words</span>
                              )}
                            </div>
                          )}
                          
                          <div className="flex items-center gap-2">
                            <Button 
                              size="sm" 
                              variant="outline"
                              onClick={() => handleViewAudit(log.id)}
                              data-testid={`button-view-audit-${log.id}`}
                            >
                              <Eye className="w-4 h-4 mr-1" />
                              View Audit
                            </Button>
                            <Button 
                              size="icon" 
                              variant="ghost"
                              onClick={() => handleDownloadReport(log.id)}
                              data-testid={`button-download-audit-${log.id}`}
                            >
                              <Download className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <AuditPanel 
        auditLogId={selectedAuditId}
        isOpen={showAuditPanel}
        onClose={() => setShowAuditPanel(false)}
      />
    </div>
  );
}
