package ai.kilocode.jetbrains.ui

import com.google.gson.JsonParser
import com.intellij.ide.projectView.TreeStructureProvider
import com.intellij.ide.projectView.ViewSettings
import com.intellij.ide.util.treeView.AbstractTreeNode
import com.intellij.openapi.diagnostic.Logger
import com.intellij.psi.PsiDirectory
import java.nio.file.Files
import java.nio.file.Path

/** Hide only the project's portable IVOL history, never similarly named nested folders. */
class ProjectTaskStorageTreeProvider : TreeStructureProvider {
    private val logger = Logger.getInstance(ProjectTaskStorageTreeProvider::class.java)

    override fun modify(
        parent: AbstractTreeNode<*>,
        children: MutableCollection<AbstractTreeNode<*>>,
        settings: ViewSettings?,
    ): MutableCollection<AbstractTreeNode<*>> {
        val base = parent.project?.basePath ?: return children
        val storage = Path.of(base, ".ivol")
        val config = storage.resolve("project.json")
        if (!Files.isRegularFile(config) || Files.isSymbolicLink(storage) || Files.isSymbolicLink(config)) return children
        val hide = try {
            val json = JsonParser.parseString(Files.readString(config)).asJsonObject
            json.get("version")?.asInt == 1 && json.get("hide")?.asBoolean == true
        } catch (error: Exception) {
            logger.warn("Could not read project task storage visibility", error)
            false
        }
        if (!hide) return children
        return children.filterNot { node ->
            val directory = node.value as? PsiDirectory
            directory?.virtualFile?.path == storage.toString()
        }.toMutableList()
    }
}
