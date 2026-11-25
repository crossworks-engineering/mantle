/*
 * mpp-to-mspdi: a Microsoft Project file (.mpp, .mpt) to MSPDI XML, the
 * XML Project itself saves. Built with MPXJ (LGPL-2.1-or-later) as a
 * GraalVM native binary in the parser image (the Dockerfile's mpxj-build
 * stage). The parser runs it as a child, then the plan-mspdi reader reads
 * the XML (server/parser/src/mpp.ts).
 *
 * Usage: mpp-to-mspdi <in.mpp> <out.xml>
 *        mpp-to-mspdi --version     (prints "mpxj <version>")
 *
 * Exit codes, the parser's only contract with this program:
 *   0  done, the XML is written
 *   2  wrong arguments, or the input is not there
 *   3  the file is password protected (a read password is set)
 *   4  not a Project file MPXJ knows, or a damaged one
 *   1  any other failure
 * The last line on stderr says why, in plain words.
 */
import java.io.File;
import org.mpxj.MPXJ;
import org.mpxj.MPXJException;
import org.mpxj.ProjectFile;
import org.mpxj.mpp.MPPReader;
import org.mpxj.mspdi.MSPDIWriter;

public final class MppToMspdi {
  private MppToMspdi() {}

  public static void main(String[] args) {
    // POI logs through the Log4j API, which finds no logger here and says so
    // on stderr. Its own simple logger, errors only, keeps stderr to the
    // one reason line below (set before POI loads).
    System.setProperty("log4j.provider", "org.apache.logging.log4j.simple.internal.SimpleProvider");
    System.setProperty("log4j2.loggerContextFactory", "org.apache.logging.log4j.simple.SimpleLoggerContextFactory");
    if (args.length == 1 && args[0].equals("--version")) {
      System.out.println("mpxj " + MPXJ.VERSION);
      return;
    }
    if (args.length != 2) {
      fail(2, "usage: mpp-to-mspdi <in.mpp> <out.xml>");
    }
    File in = new File(args[0]);
    if (!in.isFile()) fail(2, "input not found");
    MPPReader reader = new MPPReader();
    // The Gantt chart's fonts and colours: MSPDI has no place for them,
    // and reading them loads java.awt, which the native binary lacks.
    reader.setReadPresentationData(false);
    ProjectFile project = null;
    try {
      project = reader.read(in);
    } catch (MPXJException e) {
      String msg = String.valueOf(e.getMessage());
      if (msg.startsWith(MPXJException.PASSWORD_PROTECTED)) fail(3, "password protected");
      // The cause names what broke, for whoever reads the parser's log.
      String cause = e.getCause() == null ? "" : " (" + e.getCause() + ")";
      fail(4, "not readable as a Microsoft Project file: " + msg + cause);
    } catch (OutOfMemoryError e) {
      fail(1, "conversion failed: " + e);
    } catch (RuntimeException e) {
      // A cut or damaged file breaks the reader somewhere inside.
      fail(4, "damaged: " + e);
    }
    if (project == null) fail(4, "not a Microsoft Project file");
    try {
      new MSPDIWriter().write(project, new File(args[1]));
    } catch (Throwable e) {
      fail(1, "conversion failed: " + e);
    }
  }

  private static void fail(int code, String why) {
    System.err.println(why);
    System.exit(code);
  }
}
