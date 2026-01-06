import { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Copy, Download, X, Loader2, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface StreamChunk {
  type: 'section_complete' | 'progress' | 'outline' | 'complete';
  sectionTitle?: string;
  chunkText?: string;
  sectionIndex?: number;
  totalChunks?: number;
  progress?: number;
  stage?: string;
  wordCount?: number;
  totalWordCount?: number;
}

interface StreamingOutputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete?: (finalText: string) => void;
}

export function StreamingOutputModal({ isOpen, onClose, onComplete }: StreamingOutputModalProps) {
  const [content, setContent] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const [currentSection, setCurrentSection] = useState<string>('');
  const [sectionsCompleted, setSectionsCompleted] = useState(0);
  const [totalSections, setTotalSections] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [copied, setCopied] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    setContent('');
    setProgress(0);
    setCurrentSection('Connecting...');
    setSectionsCompleted(0);
    setTotalSections(0);
    setWordCount(0);
    setIsComplete(false);
    setCopied(false);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/cc-stream`;
    
    console.log('[StreamingModal] Connecting to WebSocket:', wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[StreamingModal] WebSocket connected');
      setCurrentSection('Waiting for generation to start...');
    };

    ws.onmessage = (event) => {
      try {
        const data: StreamChunk = JSON.parse(event.data);
        console.log('[StreamingModal] Received:', data.type);

        switch (data.type) {
          case 'outline':
            setCurrentSection('Outline generated, starting sections...');
            if (data.totalChunks) {
              setTotalSections(data.totalChunks);
            }
            break;

          case 'section_complete':
            if (data.chunkText) {
              setContent(prev => {
                const newContent = prev ? prev + '\n\n' + data.chunkText : data.chunkText || '';
                return newContent;
              });
            }
            if (data.sectionTitle) {
              setCurrentSection(`Completed: ${data.sectionTitle}`);
            }
            if (data.sectionIndex !== undefined) {
              setSectionsCompleted(data.sectionIndex + 1);
            }
            if (data.totalChunks) {
              setTotalSections(data.totalChunks);
            }
            if (data.progress !== undefined) {
              setProgress(data.progress);
            }
            if (data.totalWordCount !== undefined) {
              setWordCount(data.totalWordCount);
            }
            setTimeout(scrollToBottom, 100);
            break;

          case 'complete':
            setIsComplete(true);
            setProgress(100);
            setCurrentSection('Generation complete!');
            if (data.totalWordCount !== undefined) {
              setWordCount(data.totalWordCount);
            }
            toast({
              title: "Generation Complete",
              description: `${data.totalWordCount?.toLocaleString() || wordCount.toLocaleString()} words generated successfully.`,
            });
            break;
        }
      } catch (err) {
        console.error('[StreamingModal] Parse error:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('[StreamingModal] WebSocket error:', error);
      setCurrentSection('Connection error - check console');
    };

    ws.onclose = () => {
      console.log('[StreamingModal] WebSocket closed');
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      wsRef.current = null;
    };
  }, [isOpen, toast, scrollToBottom, wordCount]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast({
        title: "Copied!",
        description: "Content copied to clipboard.",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast({
        title: "Copy failed",
        description: "Could not copy to clipboard.",
        variant: "destructive",
      });
    }
  };

  const handleSave = () => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neurotext-output-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({
      title: "Saved!",
      description: "File downloaded successfully.",
    });
  };

  const handleClose = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    if (isComplete && content && onComplete) {
      onComplete(content);
    }
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col gap-4">
        <DialogHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <DialogTitle className="flex items-center gap-2">
            {isComplete ? (
              <CheckCircle2 className="w-5 h-5 text-green-500" />
            ) : (
              <Loader2 className="w-5 h-5 animate-spin" />
            )}
            <span>
              {isComplete ? 'Generation Complete' : 'Generating Document...'}
            </span>
          </DialogTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              disabled={!content}
              data-testid="button-copy-stream"
            >
              {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span className="ml-1">{copied ? 'Copied' : 'Copy'}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={!content}
              data-testid="button-save-stream"
            >
              <Download className="w-4 h-4" />
              <span className="ml-1">Save TXT</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClose}
              data-testid="button-close-stream"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
            <span>{currentSection}</span>
            <span>
              {sectionsCompleted}/{totalSections} sections
              {wordCount > 0 && ` | ${wordCount.toLocaleString()} words`}
            </span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>

        <ScrollArea className="flex-1 rounded-md border p-4">
          <div ref={scrollRef} className="whitespace-pre-wrap font-mono text-sm">
            {content || (
              <span className="text-muted-foreground italic">
                Waiting for content... The document will appear here section by section as it is generated.
              </span>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
