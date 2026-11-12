"""One FIFO consumer; durable task records are owned by the server callbacks."""
import logging
import threading

logger = logging.getLogger(__name__)


class RecognitionWorker:
    def __init__(self, take_next, process, failed, finished):
        self.take_next, self.process = take_next, process
        self.failed, self.finished = failed, finished
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self._work, name='audio-recognition-queue', daemon=True)

    def start(self):
        self.thread.start()

    def notify(self):
        self.wake.set()

    def stop(self):
        self.stopping.set()
        self.wake.set()
        self.thread.join(timeout=2)

    def _work(self):
        while not self.stopping.is_set():
            self.wake.clear()
            try:
                record = self.take_next()
            except Exception:
                # A temporary disk/read failure must not permanently kill the queue.
                logger.exception('Unable to read recognition queue')
                self.wake.wait(1)
                continue
            if record is None:
                self.wake.wait(1)
                continue
            try:
                self.process(record)
            except Exception as exc:
                try:
                    self.failed(record, exc)
                except Exception:
                    logger.exception('Unable to save recognition failure')
            finally:
                try:
                    self.finished(record)
                except Exception:
                    logger.exception('Unable to finalize recognition queue item')
