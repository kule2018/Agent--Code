import { Module } from '@nestjs/common'
import { AppController } from './app.controller.js'
import { PresentationController } from './presentation/presentation.controller.js'
import { PresentationExportService } from './presentation/export.service.js'
import { PresentationGraphService } from './presentation/presentation-graph.service.js'
import { PresentationModelService } from './presentation/model.service.js'
import { PresentationRepository } from './presentation/presentation.repository.js'
import { PresentationService } from './presentation/presentation.service.js'

@Module({
	controllers: [AppController, PresentationController],
	providers: [
		PresentationRepository,
		PresentationModelService,
		PresentationExportService,
		PresentationGraphService,
		PresentationService
	]
})
export class AppModule {}

