import java.io.File;
import java.util.zip.ZipFile;

public class TestZip {
    public static void main(String[] args) {
        File dir = new File("/app/apps/daemon/data/0e28de71-ef1c-4469-972a-2139a7300a95/mods");
        if (!dir.exists() || !dir.isDirectory()) {
            System.out.println("Directory not found");
            return;
        }

        File[] files = dir.listFiles((d, name) -> name.endsWith(".jar"));
        if (files == null) return;

        for (File f : files) {
            try (ZipFile zf = new ZipFile(f)) {
                // Do nothing, just opening it checks the headers
            } catch (Exception e) {
                System.out.println("CORRUPT_JAVA: " + f.getName() + " - " + e.getMessage());
            }
        }
        System.out.println("DONE_JAVA");
    }
}
