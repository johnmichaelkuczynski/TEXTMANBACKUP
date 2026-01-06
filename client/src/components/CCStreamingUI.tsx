import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Play, Square, CheckCircle, AlertCircle, Clock, FileText, Copy, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface ChunkResult {
  chunkIndex: number;
  chunkText: string;
  actualWords: number;
  targetWords: number;
  minWords: number;
  maxWords: number;
  status: 'on_target' | 'retrying' | 'passed_after_retry' | 'flagged';
}

interface CCStreamingUIProps {
  text: string;
  customInstructions?: string;
  onComplete: (finalOutput: string, stats: JobStats) => void;
  onError: (error: string) => void;
}

interface JobStats {
  inputWords: number;
  outputWords: number;
  targetWords: number;
  totalChunks: number;
  processingTimeMs: number;
  lengthMode: string;
}

type Phase = 'idle' | 'connecting' | 'skeleton_extraction' | 'chunk_processing' | 'stitching' | 'complete' | 'failed' | 'aborted';

export function CCStreamingUI({ text, customInstructions, onComplete, onError }: CCStreamingUIProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [chunks, setChunks] = useState<ChunkResult[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [inputWords, setInputWords] = useState(0);
  const [targetWords, setTargetWords] = useState(0);
  const [wordsProcessed, setWordsProcessed] = useState(0);
  const [projectedFinal, setProjectedFinal] = useState(0);
  const [lengthMode, setLengthMode] = useState('');
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [estimatedRemaining, setEstimatedRemaining] = useState(0);
  const [jobId, setJobId] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  
  // Chunk popup state - queue of chunks waiting to be shown
  const [chunkQueue, setChunkQueue] = useState<ChunkResult[]>([]);
  const [currentPopupChunk, setCurrentPopupChunk] = useState<ChunkResult | null>(null);
  const [popupVisible, setPopupVisible] = useState(false);
  const popupTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  
  const { toast } = useToast();

  const countWords = (t: string) => t.trim().split(/\s+/).filter(w => w).length;

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setTimeElapsed(Date.now() - startTimeRef.current);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  // Show next chunk from queue
  const showNextChunk = useCallback(() => {
    setChunkQueue(prev => {
      if (prev.length === 0) {
        setPopupVisible(false);
        setCurrentPopupChunk(null);
        return prev;
      }
      const [next, ...rest] = prev;
      setCurrentPopupChunk(next);
      setPopupVisible(true);
      return rest;
    });
  }, []);

  // Dismiss current popup and show next
  const dismissPopup = useCallback(() => {
    if (popupTimerRef.current) {
      clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
    }
    showNextChunk();
  }, [showNextChunk]);

  // Auto-advance popup after delay
  useEffect(() => {
    if (popupVisible && currentPopupChunk) {
      popupTimerRef.current = setTimeout(() => {
        showNextChunk();
      }, 8000); // Auto-dismiss after 8 seconds
      
      return () => {
        if (popupTimerRef.current) {
          clearTimeout(popupTimerRef.current);
        }
      };
    }
  }, [popupVisible, currentPopupChunk, showNextChunk]);

  // When a new chunk is added to queue and no popup is showing, show it
  useEffect(() => {
    if (chunkQueue.length > 0 && !popupVisible) {
      showNextChunk();
    }
  }, [chunkQueue, popupVisible, showNextChunk]);

  // Copy chunk text to clipboard
  const copyChunkText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: "Copied",
        description: "Chunk text copied to clipboard",
      });
    } catch (err) {
      toast({
        title: "Copy failed",
        description: "Could not copy to clipboard",
        variant: "destructive"
      });
    }
  }, [toast]);

  const startJob = useCallback(() => {
    const wordCount = countWords(text);
    if (wordCount < 500) {
      onError('Document too short for CC processing (minimum 500 words)');
      return;
    }
    if (wordCount > 50000) {
      onError('Document exceeds 50,000 word limit for CC streaming');
      return;
    }

    setPhase('connecting');
    setMessage('Connecting to streaming server...');
    setChunks([]);
    setChunkQueue([]);
    setCurrentPopupChunk(null);
    setPopupVisible(false);
    setWarnings([]);
    setWordsProcessed(0);
    setInputWords(wordCount);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/cc-stream`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setMessage('Connected. Starting job...');
      ws.send(JSON.stringify({
        type: 'start_job',
        text,
        customInstructions
      }));
      startTimer();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setPhase('failed');
      setMessage('WebSocket connection failed');
      stopTimer();
      onError('Failed to connect to streaming server');
    };

    ws.onclose = () => {
      if (phase !== 'complete' && phase !== 'failed' && phase !== 'aborted') {
        setMessage('Connection closed');
      }
    };
  }, [text, customInstructions, onError, startTimer, stopTimer]);

  const handleMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'job_started':
        setJobId(data.jobId);
        setTotalChunks(data.totalChunks);
        setInputWords(data.inputWords);
        setTargetWords(data.targetWords);
        setLengthMode(data.lengthMode);
        setMessage(`Job started: ${data.totalChunks} chunks to process`);
        break;

      case 'progress':
        setPhase(data.phase);
        setMessage(data.message);
        if (data.completedChunks !== undefined) {
          setWordsProcessed(data.wordsProcessed || 0);
          setProjectedFinal(data.projectedFinal || 0);
          if (data.estimatedRemaining) {
            setEstimatedRemaining(data.estimatedRemaining);
          }
        }
        break;

      case 'chunk_complete':
        const chunk: ChunkResult = {
          chunkIndex: data.chunkIndex,
          chunkText: data.chunkText,
          actualWords: data.actualWords,
          targetWords: data.targetWords,
          minWords: data.minWords,
          maxWords: data.maxWords,
          status: data.status
        };
        // Add to chunks list for final display
        setChunks(prev => [...prev, chunk]);
        // Add to popup queue for immediate display
        setChunkQueue(prev => [...prev, chunk]);
        setWordsProcessed(data.runningTotal);
        setProjectedFinal(data.projectedFinal);
        setMessage(`Chunk ${data.chunkIndex + 1}/${data.totalChunks} complete: ${data.actualWords} words (target: ${data.targetWords})`);
        break;

      case 'warning':
        setWarnings(prev => [...prev, data.message]);
        break;

      case 'job_complete':
        setPhase('complete');
        setMessage('Processing complete!');
        stopTimer();
        onComplete(data.finalOutput, {
          inputWords: inputWords,
          outputWords: data.finalWordCount,
          targetWords: data.targetWords,
          totalChunks: chunks.length + 1,
          processingTimeMs: data.timeElapsed,
          lengthMode
        });
        break;

      case 'job_failed':
        setPhase('failed');
        setMessage(`Job failed: ${data.error}`);
        stopTimer();
        onError(data.error);
        break;

      case 'job_aborted':
        setPhase('aborted');
        setMessage(`Job aborted after ${data.completedChunks}/${data.totalChunks} chunks`);
        stopTimer();
        break;

      case 'error':
        setPhase('failed');
        setMessage(data.message);
        stopTimer();
        onError(data.message);
        break;
    }
  }, [onComplete, onError, stopTimer, inputWords, chunks.length, lengthMode]);

  const abortJob = useCallback(() => {
    if (wsRef.current && jobId) {
      wsRef.current.send(JSON.stringify({ type: 'abort_job', jobId }));
    }
  }, [jobId]);

  useEffect(() => {
    return () => {
      stopTimer();
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
      }
    };
  }, [stopTimer]);

  const progressPercent = totalChunks > 0 ? (chunks.length / totalChunks) * 100 : 0;
  const isProcessing = phase === 'connecting' || phase === 'skeleton_extraction' || phase === 'chunk_processing' || phase === 'stitching';

  return (
    <>
      {/* CHUNK POPUP - Fixed position overlay */}
      {popupVisible && currentPopupChunk && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          data-testid="chunk-popup-overlay"
        >
          <div 
            className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl border-2 border-indigo-400 dark:border-indigo-600 max-w-3xl w-full mx-4 max-h-[80vh] flex flex-col"
            data-testid={`chunk-popup-${currentPopupChunk.chunkIndex}`}
          >
            {/* Popup Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 bg-indigo-50 dark:bg-indigo-900/30 rounded-t-lg">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge className="bg-indigo-600 text-white text-sm px-3 py-1">
                  Chunk {currentPopupChunk.chunkIndex + 1} of {totalChunks}
                </Badge>
                <Badge 
                  variant="outline" 
                  className={
                    currentPopupChunk.status === 'on_target' 
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' 
                      : currentPopupChunk.status === 'flagged'
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                      : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'
                  }
                >
                  {currentPopupChunk.actualWords} words
                  {currentPopupChunk.status === 'on_target' && <CheckCircle className="w-3 h-3 ml-1" />}
                  {currentPopupChunk.status === 'flagged' && <AlertCircle className="w-3 h-3 ml-1" />}
                </Badge>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  target: {currentPopupChunk.targetWords} ({currentPopupChunk.minWords}-{currentPopupChunk.maxWords})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyChunkText(currentPopupChunk.chunkText)}
                  className="border-indigo-300 dark:border-indigo-600"
                  data-testid="button-copy-chunk"
                >
                  <Copy className="w-4 h-4 mr-1" />
                  Copy
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={dismissPopup}
                  data-testid="button-dismiss-chunk-popup"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
            
            {/* Popup Body - Scrollable text */}
            <ScrollArea className="flex-1 p-4 max-h-[50vh]">
              <pre 
                className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200 font-mono leading-relaxed"
                data-testid="chunk-popup-text"
              >
                {currentPopupChunk.chunkText}
              </pre>
            </ScrollArea>
            
            {/* Popup Footer */}
            <div className="flex items-center justify-between p-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 rounded-b-lg">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {chunkQueue.length > 0 ? `${chunkQueue.length} more chunk${chunkQueue.length > 1 ? 's' : ''} waiting` : 'No more chunks in queue'}
              </div>
              <div className="flex items-center gap-2">
                {chunkQueue.length > 0 && (
                  <Button
                    size="sm"
                    onClick={dismissPopup}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                    data-testid="button-next-chunk"
                  >
                    Next Chunk
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                )}
                <span className="text-xs text-gray-400">Auto-advances in 8s</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <Card className="p-6 border-2 border-indigo-300 dark:border-indigo-700">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-indigo-900 dark:text-indigo-100">
                Cross-Chunk Coherence Streaming
              </h3>
              <Badge variant="outline" className={
                phase === 'complete' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' :
                phase === 'failed' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' :
                phase === 'aborted' ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300' :
                'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
              }>
                {phase === 'idle' ? 'Ready' : phase.replace('_', ' ').toUpperCase()}
              </Badge>
            </div>
            
            <div className="flex items-center gap-2">
              {phase === 'idle' && (
                <Button onClick={startJob} data-testid="button-start-cc-stream">
                  <Play className="w-4 h-4 mr-2" />
                  Start Streaming
                </Button>
              )}
              {isProcessing && (
                <Button variant="destructive" onClick={abortJob} data-testid="button-abort-cc-stream">
                  <Square className="w-4 h-4 mr-2" />
                  Abort
                </Button>
              )}
            </div>
          </div>

          {phase !== 'idle' && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded">
                  <div className="text-gray-500 dark:text-gray-400 flex items-center gap-1">
                    <FileText className="w-3 h-3" /> Input
                  </div>
                  <div className="text-lg font-bold">{inputWords.toLocaleString()} words</div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded">
                  <div className="text-gray-500 dark:text-gray-400">Target</div>
                  <div className="text-lg font-bold">{targetWords.toLocaleString()} words</div>
                  <div className="text-xs text-gray-400">{lengthMode}</div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded">
                  <div className="text-gray-500 dark:text-gray-400">Processed</div>
                  <div className="text-lg font-bold">{wordsProcessed.toLocaleString()} words</div>
                  <div className="text-xs text-gray-400">Projected: {projectedFinal.toLocaleString()}</div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded">
                  <div className="text-gray-500 dark:text-gray-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Time
                  </div>
                  <div className="text-lg font-bold">{formatTime(timeElapsed)}</div>
                  {estimatedRemaining > 0 && (
                    <div className="text-xs text-gray-400">~{formatTime(estimatedRemaining)} remaining</div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{message}</span>
                  <span className="font-medium">{chunks.length}/{totalChunks} chunks</span>
                </div>
                <Progress value={progressPercent} className="h-2" />
              </div>

              {warnings.length > 0 && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded p-3">
                  <div className="flex items-center gap-2 text-yellow-800 dark:text-yellow-200 font-medium mb-1">
                    <AlertCircle className="w-4 h-4" />
                    Warnings
                  </div>
                  {warnings.map((w, i) => (
                    <div key={i} className="text-sm text-yellow-700 dark:text-yellow-300">{w}</div>
                  ))}
                </div>
              )}

              <div className="border-t pt-4">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  Completed Chunks
                  {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {chunkQueue.length > 0 && (
                    <Badge variant="outline" className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 text-xs">
                      {chunkQueue.length} in popup queue
                    </Badge>
                  )}
                </h4>
                <ScrollArea className="h-[300px] border rounded p-2 bg-gray-50 dark:bg-gray-900">
                  {chunks.length === 0 ? (
                    <div className="text-center text-gray-400 py-8">
                      Waiting for first chunk...
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {chunks.map((chunk) => (
                        <div 
                          key={chunk.chunkIndex} 
                          className="border-b pb-4 last:border-b-0"
                          data-testid={`cc-chunk-${chunk.chunkIndex}`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">
                                Chunk {chunk.chunkIndex + 1}
                              </Badge>
                              <Badge 
                                variant="outline" 
                                className={
                                  chunk.status === 'on_target' 
                                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700' 
                                    : chunk.status === 'flagged'
                                    ? 'bg-red-100 dark:bg-red-900/30 text-red-700'
                                    : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700'
                                }
                              >
                                {chunk.actualWords} words
                                {chunk.status === 'on_target' && <CheckCircle className="w-3 h-3 ml-1" />}
                                {chunk.status === 'flagged' && <AlertCircle className="w-3 h-3 ml-1" />}
                              </Badge>
                              <span className="text-xs text-gray-400">
                                (target: {chunk.targetWords})
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => copyChunkText(chunk.chunkText)}
                              className="text-xs"
                              data-testid={`button-copy-chunk-${chunk.chunkIndex}`}
                            >
                              <Copy className="w-3 h-3 mr-1" />
                              Copy
                            </Button>
                          </div>
                          <pre className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200 font-mono line-clamp-4">
                            {chunk.chunkText}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
